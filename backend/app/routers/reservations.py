"""预订全流程：创建（按房型或锁定房号）、拖动改期/换房、入住、退房结算、账目与收款"""
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import (balance_of, blocking_ids, can_access_hotel, fmt_money, folio_totals, free_rooms,
                      get_current_user, log_op, money, resolve_hotel_id)
from app.models import (Channel, FolioItem, Guest, HourlyRate, OperationLog,
                        Payment, Reservation, Room, RoomType, User)
from app.schemas import (CheckInBody, CheckOutBody, ExtendBody, FolioItemBody,
                         MergeChainBody, PaidTotalBody, PaymentBody, RegistrationBody,
                         ReservationBody, ReservationOut, ReservationPatch)
from app.routers.payment_methods import assert_method_usable, pay_method_label
from app.security import decrypt_field, encrypt_field

router = APIRouter(prefix="/api/reservations", tags=["reservations"])


def _hourly_rate_for(db: Session, rt: RoomType, hours: int) -> float:
    """钟点默认每小时单价：hours 精确命中的档位总价 ÷ 小时数；未命中回落最大档折合单价。"""
    tiers = db.query(HourlyRate).filter(HourlyRate.room_type_id == rt.id).order_by(HourlyRate.hours).all()
    exact = next((x for x in tiers if x.hours == hours), None)
    if exact:
        return money(exact.price / exact.hours)
    if tiers:
        ref = tiers[-1]
        return money(ref.price / ref.hours * hours)
    return 0


def _remark_suffix(remark: str) -> str:
    """收款日志摘要的备注后缀（非空才追加；删除收款时记录被物理删除，日志必须留痕原文）"""
    remark = (remark or "").strip()
    return f" · 备注「{remark}」" if remark else ""


# ---------- 序列化 ----------
def room_charge_total_of(db: Session, res_id: int) -> float:
    """房费合计（Σ category='room_charge' 账目）——合并/分段计价订单的收入口径。

    连住合并（自动并入 / 手动 merge-chain）之后房费分多行、单价也不同，
    rate × nights 不再等于应收，前端展示与编辑初值都必须取这个值。"""
    rows = (db.query(FolioItem)
            .filter(FolioItem.reservation_id == res_id, FolioItem.category == "room_charge")
            .all())
    return money(sum(x.amount for x in rows))


def res_out(db: Session, r: Reservation, *, merged: bool = False) -> ReservationOut:
    guest = db.get(Guest, r.guest_id)
    rt = db.get(RoomType, r.room_type_id)
    room = db.get(Room, r.room_id) if r.room_id else None
    ch = db.get(Channel, r.channel_id) if r.channel_id else None
    op = db.get(User, r.created_by) if r.created_by else None
    nights = (r.check_out - r.check_in).days
    return ReservationOut(
        id=r.id, code=r.code,
        guest_id=r.guest_id,
        guest_name=guest.name if guest else "",
        guest_phone=guest.phone if guest else "",
        vip_level=guest.vip_level if guest else "",
        room_type_id=r.room_type_id,
        room_type_name=rt.name if rt else "",
        room_id=r.room_id,
        room_number=room.room_number if room else None,
        room_status=room.status if room else None,
        check_in=r.check_in, check_out=r.check_out,
        actual_check_out=r.actual_check_out,
        nights=nights,
        status=r.status,
        channel_id=r.channel_id,
        channel_name=ch.name if ch else None,
        channel_color=ch.color if ch else None,
        rate=r.rate, stay_type=r.stay_type, hours=r.hours,
        notes=r.notes,
        balance_due=max(0.0, balance_of(db, r.id)),
        paid_total=folio_totals(db, r.id)[1],
        room_charge_total=room_charge_total_of(db, r.id),
        merged=merged,
        external_ref=r.external_ref,
        operator_name=op.name if op else None,
        created_at=r.created_at,
    )


def gen_code(db: Session, check_in: date) -> str:
    n = db.query(Reservation).filter(
        Reservation.check_in == check_in).count() + 1
    while True:
        code = f"YQ{check_in:%Y%m%d}{n:02d}"
        if not db.query(Reservation).filter(Reservation.code == code).first():
            return code
        n += 1


def recalc_room_charge(db: Session, r: Reservation) -> None:
    """按当前房价与住期重算房费账目，并把多条房费行收拢为一条。

    连住合并（自动并入 / 手动 merge-chain）与延住都会让一笔订单挂多条 room_charge：
    拖动改期或编辑总额若只重算首条，会与追加行叠加产生双重计费（旧已知边界）。
    这里按「新 rate × 晚数/小时数」重写首条并删除其余房费行——改期后的整单房费
    只有一条按新口径计的账目；杂费（category='other'）与收款不受影响。"""
    fees = (db.query(FolioItem)
            .filter(FolioItem.reservation_id == r.id, FolioItem.category == "room_charge")
            .order_by(FolioItem.id)
            .all())
    if not fees:
        return
    first, extra = fees[0], fees[1:]
    if r.stay_type == "hourly":
        first.amount = money(r.hours * r.rate)
        first.description = f"钟点房费 · {r.hours} 小时 × ¥{fmt_money(r.rate)}"
    else:
        nights = (r.check_out - r.check_in).days
        first.amount = money(nights * r.rate)
        first.description = f"房费 · {nights} 晚 × ¥{fmt_money(r.rate)}"
    for x in extra:
        db.delete(x)


def upsert_guest(db: Session, hotel_id: int, name: str, phone: str, id_number: str) -> Guest:
    g = None
    if phone:
        g = db.query(Guest).filter(Guest.hotel_id == hotel_id, Guest.phone == phone).first()
    if g is None and not phone:
        g = db.query(Guest).filter(Guest.hotel_id == hotel_id, Guest.name == name).first()
    if g is None:
        # 新建档前校验证件号：同店已有档案用该证件号说明是老客，应走客人联想选中已有档案
        # （证件号密文存储不可 SQL 等值 → 本店解密内存比对，口径同 guests._dup_check）
        if id_number.strip():
            for other in db.query(Guest).filter(Guest.hotel_id == hotel_id):
                if decrypt_field(other.id_number) == id_number.strip():
                    raise HTTPException(
                        400, f"证件号已属于客户档案「{other.name}」，请在客人联想中选择该档案")
        g = Guest(hotel_id=hotel_id, name=name.strip(), phone=phone.strip(),
                  id_number=encrypt_field(id_number.strip()))
        db.add(g)
        db.flush()
    else:
        if id_number and not g.id_number:
            g.id_number = encrypt_field(id_number.strip())
    return g


def _notes_append(old: str, new: str) -> str:
    """连住并入时合并备注：追加不重复的片段，截到列宽 200。"""
    old = (old or "").strip()
    new = (new or "").strip()
    if not new or new in old:
        return old
    joined = f"{old}；{new}" if old else new
    return joined[:200]


def apply_guest_identity_changes(db: Session, r: Reservation, g: Guest | None,
                                 new_name: str | None, new_phone: str | None,
                                 changes: list[str]) -> None:
    """客人姓名 / 手机号更正：改的是 guests 档案本身（该客人全部订单跟随更新）。

    空姓名 400；手机号同店撞其他档案 400（按手机号复用档案是预订创建的联动口径，
    同店两档案共用一个号码会让自动挂档无所适从）。变更摘要追加进 changes。"""
    if new_name is not None and not new_name:
        raise HTTPException(400, "客人姓名不能为空")
    if new_phone is not None and new_phone and g:
        dup = (db.query(Guest)
               .filter(Guest.hotel_id == r.hotel_id, Guest.phone == new_phone,
                       Guest.id != g.id)
               .first())
        if dup:
            raise HTTPException(400, f"手机号已属于客户档案「{dup.name}」，请核对后再改")
    if g:
        if new_name is not None and new_name != g.name:
            changes.append(f"姓名 {g.name}→{new_name}")
            g.name = new_name
        if new_phone is not None and new_phone != g.phone:
            changes.append(f"手机号 {g.phone or '未留'}→{new_phone or '未留'}")
            g.phone = new_phone


def apply_channel_and_notes_changes(db: Session, r: Reservation,
                                    channel_id: int | None, notes: str | None,
                                    changes: list[str]) -> None:
    """预订来源 / 备注（编辑预订与在住登记编辑共用：本店校验、变更摘要）。"""
    if channel_id is not None and channel_id != r.channel_id:
        ch = db.get(Channel, channel_id)
        if not ch or ch.hotel_id != r.hotel_id:
            raise HTTPException(400, "来源渠道不存在")
        old = db.get(Channel, r.channel_id) if r.channel_id else None
        changes.append(f"来源 {old.name if old else '未填'}→{ch.name}")
        r.channel_id = ch.id
    if notes is not None and notes != r.notes:
        changes.append(f"备注「{r.notes or '空'}」→「{notes or '空'}」")
        r.notes = notes


def join_chain_target(db: Session, *, hotel_id: int, guest_id: int,
                      channel_id: int | None, room_id: int | None,
                      room_type_id: int, check_in: date, check_out: date) -> Reservation | None:
    """找可并入的连住订单（开单自动并入的判定核心）。

    条件全部满足才并入：同店、同客人、同来源、同一笔住法（整晚）、状态仍在
    pending/confirmed/checked_in、且日期严格首尾相接（本单接在它后面，或本单接在它前面）。
    已退房 / 已取消 / 钟点房一律不参与（历史账目口径不动、钟点按小时计不按夜连片）。
    房间：指定房号要求同房号；按房型预订要求同房型且该房在新增夜次无冲突（冲突则返回 None
    让调用方正常新建——不能因为「想并」而忽略占房校验）。"""
    candidates = (db.query(Reservation)
                  .filter(Reservation.hotel_id == hotel_id,
                          Reservation.guest_id == guest_id,
                          Reservation.stay_type == "normal",
                          Reservation.status.in_(["pending", "confirmed", "checked_in"]))
                  .all())
    best = None
    for c in candidates:
        if (c.channel_id or None) != (channel_id or None):
            continue
        if c.check_out == check_in:      # 接在它后面（最常见：按晚续开下一晚）
            extend_in, extend_out = c.check_out, check_out
        elif c.check_in == check_out and c.status != "checked_in":
            # 接在它前面（补开更早的一晚）；已在住的单只能往后延，往前插会破坏已办入住的住期
            extend_in, extend_out = check_in, c.check_in
        else:
            continue
        if room_id is not None:
            if c.room_id != room_id:
                continue
        else:
            if c.room_type_id != room_type_id:
                continue
            # 冲突口径对齐规则 3a：在住单按「延住」算——只按未到店预订计冲突
            # （include_checked_in=False）；未到店的单照常全量校验（在住也算占房）
            if c.room_id is not None and blocking_ids(
                    db, hotel_id, c.room_id, extend_in, extend_out,
                    exclude=c.id, include_checked_in=(c.status != "checked_in")):
                continue
        # 同客同房命中多个（前后各一笔）时优先「接在后面」——续住语义更常见
        rank = 0 if c.check_out == check_in else 1
        if best is None or rank < best[0]:
            best = (rank, c)
    return best[1] if best else None


def absorb_into_chain(db: Session, target: Reservation, body: ReservationBody,
                      rate: float, nights: int, user: User) -> Reservation:
    """把本次开单并入连住目标订单：扩展住期 + 追加一条房费行（原房费行不动）。

    价格口径：新晚数按本单自己的 rate 追加「续住房费 · N 晚 × ¥X」，不篡改已开价格
    （相邻两晚房价不同也照并，整单应收 = 两段相加）。
    已入住的订单按延住口径写「延住房费」，状态与房态都不动。"""
    appending = target.check_out == body.check_in      # True=接在后面（续住）
    was_checked_in = target.status == "checked_in"
    if appending:
        target.check_out = body.check_out
    else:
        # 只可能是「接在前面」（补开更早的一晚）——join_chain_target 已排除在住单的前插
        target.check_in = body.check_in
    desc_prefix = "延住房费" if was_checked_in else "续住房费"
    amount = money(nights * rate)
    db.add(FolioItem(hotel_id=target.hotel_id, reservation_id=target.id,
                     category="room_charge",
                     description=f"{desc_prefix} · {nights} 晚 × ¥{fmt_money(rate)}",
                     amount=amount, created_by=user.id))
    target.notes = _notes_append(target.notes, body.notes)
    db.flush()
    g = db.get(Guest, target.guest_id)
    span = f"{body.check_in:%m/%d}–{body.check_out:%m/%d}"
    log_op(db, target.hotel_id, user, "reservation_merge", "reservation", target.id,
           f"连住并入 {g.name if g else ''} · {target.code}：{span} {nights} 晚 × ¥{fmt_money(rate)}"
           f"（应收 ¥{fmt_money(amount)}，{'延住' if was_checked_in else '续住'}，原房费保留）")
    return target


# ---------- 列表 ----------
@router.get("")
def list_reservations(
    date_str: str | None = Query(None, alias="date"),      # 抵店日期
    status: str | None = None,
    q: str | None = None,             # 客人 / 手机号 / 预订号
    from_date: str | None = None,
    to_date: str | None = None,
    hotel_id: int | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    hid = resolve_hotel_id(db, user, hotel_id)
    qy = db.query(Reservation).filter(Reservation.hotel_id == hid)
    if date_str:
        d = date.fromisoformat(date_str)
        qy = qy.filter(Reservation.check_in == d)
    if from_date:
        qy = qy.filter(Reservation.check_out > date.fromisoformat(from_date))
    if to_date:
        qy = qy.filter(Reservation.check_in < date.fromisoformat(to_date))
    if status and status != "all":
        qy = qy.filter(Reservation.status == status)
    qy = qy.order_by(Reservation.check_in.desc(), Reservation.id.desc())
    out = [res_out(db, r) for r in qy.all()]
    if q:
        qkw = q.strip().lower()
        out = [x for x in out if qkw in x.guest_name.lower()
               or qkw in (x.guest_phone or "").lower()
               or qkw in x.code.lower()
               or qkw in (x.room_number or "").lower()]
    return out


# ---------- 创建（预订管理 / 房态盘直接预订共用） ----------
@router.post("")
def create_reservation(body: ReservationBody, hotel_id: int | None = None,
                       user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    hid = resolve_hotel_id(db, user, hotel_id)
    if body.check_out <= body.check_in:
        raise HTTPException(400, "离店日期必须晚于入住日期")
    if body.rate is not None and body.rate < 0:
        raise HTTPException(400, "房价不能为负数")

    # 钟点房：占用整日（check_out = check_in + 1，沿用半开区间冲突判断），按时长计价
    if body.stay_type == "hourly":
        if not (1 <= body.hours <= 12):
            raise HTTPException(400, "钟点房时长需在 1–12 小时之间")
        check_in = body.check_in
        check_out = check_in + timedelta(days=1)
        nights = 1
        hours = body.hours
    else:
        if body.hours:
            raise HTTPException(400, "仅钟点房可指定入住时长")
        check_in, check_out = body.check_in, body.check_out
        nights = (check_out - check_in).days
        hours = 0

    room = None
    rt = None
    if body.room_id:
        # 直接预订：锁定房号
        room = db.get(Room, body.room_id)
        if not room or room.hotel_id != hid:
            raise HTTPException(400, "客房不存在")
        if room.status == "maintenance":
            raise HTTPException(400, f"{room.room_number} 维修中，不可预订")
        # 冲突校验必须留在并入判定之前：并入只会延伸本客自己的相邻单，
        # 新增夜次若被别人占着仍要 409（不能被「想并」绕过占房校验）
        if blocking_ids(db, hid, room.id, check_in, check_out):
            raise HTTPException(409, f"{room.room_number} 所选时段已被占用")
        rt = db.get(RoomType, room.room_type_id)
        rate = body.rate if body.rate is not None else rt.base_price
        room_type_id = rt.id
    else:
        # 按房型预订：先解析房型与价格；可售数量校验放到「合并不成立」之后
        # （客人自己刚订的相邻单会占住该房，先做可售校验会把自己挡住误报满房）
        if not body.room_type_id:
            raise HTTPException(400, "请选择房型或指定房号")
        rt = db.get(RoomType, body.room_type_id)
        if not rt or rt.hotel_id != hid:
            raise HTTPException(400, "房型不存在")
        rate = body.rate if body.rate is not None else rt.base_price
        room_type_id = rt.id

    if body.stay_type == "hourly":
        # 铁律：房型未配置钟点价档位不可按钟点房售卖——显式传价也不放行
        tiers = db.query(HourlyRate).filter(HourlyRate.room_type_id == rt.id).all() if rt else []
        if not tiers:
            raise HTTPException(400, f"房型「{rt.name if rt else ''}」未配置钟点价，不能按钟点房售卖，请先在设置 → 房型 中配置")
        if body.rate is None:
            # 默认价：hours 精确命中的档位总价 ÷ 小时数（rate 语义 = 每小时单价，账目口径不变）；
            # 未命中档位（如自定义 5 小时）回落最大档折合单价
            rate = _hourly_rate_for(db, rt, hours)
        elif rate <= 0:
            raise HTTPException(400, "请设置钟点房价")

    if body.channel_id:
        ch = db.get(Channel, body.channel_id)
        if not ch or ch.hotel_id != hid:
            raise HTTPException(400, "来源渠道不存在")

    guest = upsert_guest(db, hid, body.guest_name, body.guest_phone, body.guest_id_number)

    # 预收款校验提前到写入前（金额/方式/备注任一非法都直接 400，不留半成品订单）；
    # 实际 Payment 写入在建单或并入之后（两条路径都要收——并入单同样会带押金）
    deposit_amt = money(body.deposit_amount) if body.deposit_amount is not None else 0.0
    deposit_remark = ""
    if deposit_amt > 0:
        deposit_remark = (body.deposit_remark or "").strip()
        if len(deposit_remark) > 120:
            raise HTTPException(400, "备注最多 120 字")
        assert_method_usable(db, hid, body.deposit_method)

    def _write_deposit(res: Reservation) -> bool:
        """把预收款落成一笔 Payment + payment 日志（新建与连住并入两条路径共用）。"""
        if deposit_amt <= 0:
            return False
        db.add(Payment(hotel_id=hid, reservation_id=res.id,
                       method=body.deposit_method, amount=deposit_amt,
                       remark=deposit_remark, created_by=user.id))
        db.flush()
        log_op(db, hid, user, "payment", "payment", res.id,
               f"预收款 ¥{fmt_money(deposit_amt)} · {pay_method_label(db, hid, body.deposit_method)}{_remark_suffix(deposit_remark)}")
        return True

    # 连住自动并入：同客 / 同来源 / 同房（或同房型）/ 日期首尾相接 且仍在预订或已入住 →
    # 不新建订单，直接扩原单住期并追加一条房费（原房费保留，价格不同也照并）。
    # 钟点房不参与（按小时计不按夜连片），已退房/已取消不参与（历史账目口径不动）。
    if body.stay_type == "normal":
        target = join_chain_target(
            db, hotel_id=hid, guest_id=guest.id, channel_id=body.channel_id,
            room_id=room.id if room else None, room_type_id=room_type_id,
            check_in=check_in, check_out=check_out)
        if target is not None:
            absorb_into_chain(db, target, body, rate, nights, user)
            if _write_deposit(target):
                log_op(db, hid, user, "reservation_extend", "reservation", target.id,
                       f"连住并入收预收款 ¥{fmt_money(deposit_amt)}（{_remark_suffix(deposit_remark).lstrip(' ·')}）")
            db.commit()
            return res_out(db, target, merged=True)

    if room is None:
        # 按房型预订且没有可并入的连住单：此时再校验可售数量并预占空净房
        free = free_rooms(db, hid, rt.id, check_in, check_out)
        if not free:
            raise HTTPException(409, "所选房型该时段已满房")
        room = free[0]  # 预留空净房；入住时允许改派

    r = Reservation(
        hotel_id=hid,
        code=gen_code(db, check_in),
        guest_id=guest.id,
        room_type_id=room_type_id,
        room_id=room.id if room else None,
        check_in=check_in,
        check_out=check_out,
        status=body.status,
        channel_id=body.channel_id,
        rate=rate,
        stay_type=body.stay_type,
        hours=hours,
        notes=body.notes,
        created_by=user.id,
    )
    db.add(r)
    db.flush()
    # 预生成房费账目（在住挂账可见）
    if body.stay_type == "hourly":
        fee_desc = f"钟点房费 · {hours} 小时 × ¥{fmt_money(rate)}"
        fee_amount = money(hours * rate)
    else:
        fee_desc = f"房费 · {nights} 晚 × ¥{fmt_money(rate)}"
        fee_amount = money(nights * rate)
    db.add(FolioItem(
        hotel_id=hid, reservation_id=r.id, category="room_charge",
        description=fee_desc,
        amount=fee_amount, created_by=user.id,
    ))
    # 预收款：校验已在建单前完成（_write_deposit 落账 + payment 日志）
    deposit_paid = _write_deposit(r)
    stay_tag = " · 钟点" if body.stay_type == "hourly" else ""
    log_op(db, hid, user, "reservation_create", "reservation", r.id,
           f"创建预订 {r.code} · {guest.name} · {rt.name}{(' · ' + room.room_number + ' 房') if room else ''} · {check_in:%m/%d}–{check_out:%m/%d}{stay_tag}"
           + (f" · 预收款 ¥{fmt_money(deposit_amt)}" if deposit_paid else ""))
    db.commit()
    return res_out(db, r)


# ---------- 编辑预订（拖动改期 / 换房 / 日期房价 / 客人姓名手机号 / 来源备注） ----------
@router.patch("/{res_id}")
def move_reservation(res_id: int, body: ReservationPatch,
                     user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (not can_access_hotel(db, user, r.hotel_id)):
        raise HTTPException(404, "预订不存在")
    if r.status not in ("pending", "confirmed", "checked_in"):
        raise HTTPException(400, "当前状态不可调整（仅待确认 / 已确认 / 在住可拖动）")
    if body.rate is not None and body.rate < 0:
        raise HTTPException(400, "房价不能为负数")
    # 钟点房占用整日固定：改期会破坏「时长 × 单价」的计费语义，仅允许换房（同占整日）
    if r.stay_type == "hourly" and (body.check_in or body.check_out):
        raise HTTPException(400, "钟点房预订不可拖动改期（占整日固定），如需调整请延住或重新开单")

    cin = body.check_in or r.check_in
    cout = body.check_out or r.check_out
    if cout <= cin:
        raise HTTPException(400, "离店日期必须晚于入住日期")

    old_room = db.get(Room, r.room_id) if r.room_id else None
    span_changed = (cin, cout) != (r.check_in, r.check_out)
    rate_changed = body.rate is not None and body.rate != r.rate

    # 换房 / 校验只在真的指定或已锁定房号时进行；按房型预订（未锁房）允许只改日期
    if body.room_id is not None or r.room_id is not None:
        new_room_id = body.room_id if body.room_id is not None else r.room_id
        room = db.get(Room, new_room_id)
        if not room or room.hotel_id != r.hotel_id:
            raise HTTPException(400, "客房不存在")
        if room.status == "maintenance":
            raise HTTPException(400, f"{room.room_number} 维修中，不可调入")
        conflict = blocking_ids(db, r.hotel_id, room.id, cin, cout, exclude=r.id)
        if conflict:
            raise HTTPException(409, f"{room.room_number} 所选时段已被占用")
        room_changed = new_room_id != r.room_id
        # 在住预订换房：旧房转空脏，新房转为在住
        if r.status == "checked_in" and room_changed and old_room:
            old_room.status = "vacant_dirty"
            room.status = "occupied"
        r.room_id = room.id
    else:
        # 按房型预订（未锁房号）：只改日期，不涉及房间与冲突
        room = None
        room_changed = False

    r.check_in = cin
    r.check_out = cout
    if rate_changed:
        r.rate = body.rate

    # 同步房费账目：按新晚数 / 新房价重算，并把合并/延住留下的多条房费行收拢为一条
    # （旧版只重算首条，叠加延住行会双重计费——已在 recalc_room_charge 内统一收拢）。
    # 钟点预订不按晚重算（账目 = 小时 × 单价，换房不影响）。
    if span_changed or rate_changed:
        recalc_room_charge(db, r)

    # ---- 客人姓名 / 手机号 / 来源 / 备注（编辑预订；口径同在住登记编辑）----
    guest = db.get(Guest, r.guest_id)
    changes: list[str] = []
    apply_guest_identity_changes(
        db, r, guest,
        body.guest_name.strip() if body.guest_name is not None else None,
        body.guest_phone.strip() if body.guest_phone is not None else None,
        changes)
    apply_channel_and_notes_changes(db, r, body.channel_id, body.notes, changes)

    detail = []
    if room_changed:
        detail.append(f"{old_room.room_number if old_room else '—'} → {room.room_number if room else '—'}")
    if span_changed:
        detail.append(f"{cin:%m/%d}–{cout:%m/%d}")
    if rate_changed:
        detail.append(f"房价 ¥{fmt_money(body.rate)}/晚")
    detail.extend(changes)
    log_op(db, r.hotel_id, user, "reservation_move", "reservation", r.id,
           f"编辑预订 {r.code}（{guest.name if guest else ''}）：{' · '.join(detail) or '无变化'}")
    db.commit()
    return res_out(db, r)


# ---------- 确认 ----------
@router.post("/{res_id}/confirm")
def confirm_reservation(res_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (not can_access_hotel(db, user, r.hotel_id)):
        raise HTTPException(404, "预订不存在")
    if r.status != "pending":
        raise HTTPException(400, "仅「待确认」预订需要确认")
    r.status = "confirmed"
    g = db.get(Guest, r.guest_id)
    log_op(db, r.hotel_id, user, "reservation_confirm", "reservation", r.id,
           f"确认预订 {r.code}（{g.name if g else ''}）")
    db.commit()
    return res_out(db, r)


# ---------- 取消 ----------
@router.post("/{res_id}/cancel")
def cancel_reservation(res_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (not can_access_hotel(db, user, r.hotel_id)):
        raise HTTPException(404, "预订不存在")
    if r.status not in ("pending", "confirmed"):
        raise HTTPException(400, "仅待确认 / 已确认的预订可取消")
    r.status = "cancelled"
    # 取消是整条流转里唯一清除已收款的环节（撤销入住 / 撤销退房都保留款项）
    pays = db.query(Payment).filter(Payment.reservation_id == r.id).all()
    paid_total = money(sum(p.amount for p in pays))
    for p in pays:
        db.delete(p)
    g = db.get(Guest, r.guest_id)
    if paid_total > 0:
        log_op(db, r.hotel_id, user, "payment", "payment", r.id,
               f"取消预订清除收款 ¥{fmt_money(paid_total)}（共 {len(pays)} 笔，无退款凭证）")
    log_op(db, r.hotel_id, user, "reservation_cancel", "reservation", r.id,
           f"取消预订 {r.code}（{g.name if g else ''}）"
           + (f" · 清除已收款 ¥{fmt_money(paid_total)}" if paid_total > 0 else ""))
    db.commit()
    return res_out(db, r)


# ---------- 钟点房到时列表（右下角提醒卡轮询源） ----------
@router.get("/overtime")
def hourly_overtime(user: User = Depends(get_current_user), db: Session = Depends(get_db),
                    hotel_id: int | None = Query(default=None)):
    """本店当前已到时的在住钟点房（now > 实际入住时刻 + 购买小时数），按超时降序。

    前端 OvertimeAlert 每 30s 轮询本端点；延住（hours 累加）/撤销入住（时刻清空）/
    退房（状态离开 checked_in）都会让预订自然退出本列表。"""
    hid = resolve_hotel_id(db, user, hotel_id)
    if hid is None:
        return []
    rows = (db.query(Reservation)
            .filter(Reservation.hotel_id == hid,
                    Reservation.stay_type == "hourly",
                    Reservation.status == "checked_in",
                    Reservation.actual_check_in.isnot(None))
            .all())
    now = datetime.now()
    out = []
    for r in rows:
        due = r.actual_check_in + timedelta(hours=r.hours)
        over_min = int((now - due).total_seconds() // 60)
        if over_min <= 0:
            continue
        room = db.get(Room, r.room_id) if r.room_id else None
        g = db.get(Guest, r.guest_id)
        ch = db.get(Channel, r.channel_id) if r.channel_id else None
        items_total, paid_total = folio_totals(db, r.id)
        out.append({
            "reservation_id": r.id,
            "code": r.code,
            "room_number": room.room_number if room else "",
            "guest_name": g.name if g else "",
            "channel_name": ch.name if ch else "",
            "hours": r.hours,
            "check_in_at": r.actual_check_in.isoformat(),
            "due_at": due.isoformat(),
            "overtime_minutes": over_min,
            "balance_due": max(0.0, money(items_total - paid_total)),
        })
    out.sort(key=lambda x: -x["overtime_minutes"])
    return out


# ---------- 入住 ----------
@router.post("/{res_id}/check-in")
def check_in(res_id: int, body: CheckInBody, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (not can_access_hotel(db, user, r.hotel_id)):
        raise HTTPException(404, "预订不存在")
    if r.status not in ("pending", "confirmed"):
        raise HTTPException(400, "仅待确认 / 已确认的预订可办理入住")
    # 未来入住的预订只能保持预订状态：入住/退房都必须等到入住日当天之后
    if r.check_in > date.today():
        raise HTTPException(400, f"入住日期为 {r.check_in:%m/%d}，尚未到店，当前只能预订，入住日当天方可办理入住")
    room = db.get(Room, body.room_id)
    if not room or room.hotel_id != r.hotel_id:
        raise HTTPException(400, "客房不存在")
    if room.status == "maintenance":
        raise HTTPException(400, f"{room.room_number} 维修中，不可入住")
    # 直接预订已锁定本房时允许房型差异；改派其他房间时房型必须一致
    if body.room_id != r.room_id and room.room_type_id != r.room_type_id:
        raise HTTPException(400, f"{room.room_number} 房型与预订不符")
    # 业务放宽：脏房、前客未退均可入住——冲突只按未到店预订计（checked_in 不阻挡）
    if blocking_ids(db, r.hotel_id, room.id, r.check_in, r.check_out,
                    exclude=r.id, include_checked_in=False):
        raise HTTPException(409, f"{room.room_number} 所选时段已被其他预订占用")

    # 若原预留了其他空房，不释放（预订记录仍挂最终房号）
    prev_status = room.status  # 覆盖前留档：脏房/前客在住要写进日志
    r.room_id = room.id
    r.status = "checked_in"
    # 实际入住时刻：钟点房到时提醒的口径（到时 = actual_check_in + hours）；撤销入住清空，
    # 撤销后再入住自然覆盖（多次重办取最后一次）
    r.actual_check_in = datetime.now()
    room.status = "occupied"

    if body.amount_received > 0:
        assert_method_usable(db, r.hotel_id, body.payment_method)
        db.add(Payment(hotel_id=r.hotel_id, reservation_id=r.id,
                       method=body.payment_method, amount=money(body.amount_received),
                       created_by=user.id))
        log_op(db, r.hotel_id, user, "payment", "payment", r.id,
               f"入住实收 ¥{fmt_money(body.amount_received)} · {pay_method_label(db, r.hotel_id, body.payment_method)}")
    g = db.get(Guest, r.guest_id)
    rt = db.get(RoomType, r.room_type_id)
    tag = "（前客未退）" if prev_status == "occupied" else ("（脏房入住）" if prev_status == "vacant_dirty" else "")
    log_op(db, r.hotel_id, user, "check_in", "reservation", r.id,
           f"办理入住 {g.name if g else ''} · {r.code} · 分配 {room.room_number} {rt.name if rt else ''}{tag}")
    db.commit()
    return res_out(db, r)


# ---------- 编辑在住登记信息（更正姓名 / 手机号 / 房价 / 来源 / 备注） ----------
@router.patch("/{res_id}/registration")
def edit_registration(res_id: int, body: RegistrationBody,
                      user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (not can_access_hotel(db, user, r.hotel_id)):
        raise HTTPException(404, "预订不存在")
    if r.status != "checked_in":
        raise HTTPException(400, "仅「在住」预订可编辑登记信息")

    g = db.get(Guest, r.guest_id)
    changes: list[str] = []

    # ---- 客人姓名 / 手机号：同步客户档案 ----
    new_name = body.guest_name.strip() if body.guest_name is not None else None
    new_phone = body.guest_phone.strip() if body.guest_phone is not None else None
    apply_guest_identity_changes(db, r, g, new_name, new_phone, changes)

    # ---- 入住天数（仅普通房）：离店日 = 入住日 + 天数，冲突只按未到店预订计 ----
    if body.nights is not None:
        if r.stay_type == "hourly":
            raise HTTPException(400, "钟点房按小时计，请用「延住」调整时长")
        if body.nights < 1:
            raise HTTPException(400, "入住天数至少 1 晚")
        new_out = r.check_in + timedelta(days=body.nights)
        if new_out != r.check_out:
            if r.room_id:
                conflict = blocking_ids(db, r.hotel_id, r.room_id, r.check_in, new_out,
                                        exclude=r.id, include_checked_in=False)
                if conflict:
                    room = db.get(Room, r.room_id)
                    raise HTTPException(409, f"{room.room_number if room else '客房'} 新住期已被其他预订占用")
            changes.append(f"住期 {r.check_out:%m/%d}→{new_out:%m/%d}（{body.nights} 晚）")
            r.check_out = new_out

    # ---- 房价（单价）/ 天数：重算首条房费账目（延住追加行不动） ----
    if body.rate is not None and body.rate < 0:
        raise HTTPException(400, "房价不能为负数")
    rate_changed = body.rate is not None and body.rate != r.rate
    if rate_changed:
        changes.append(f"房价 ¥{fmt_money(r.rate)}→¥{fmt_money(body.rate)}")
        r.rate = body.rate
    if rate_changed or body.nights is not None:
        recalc_room_charge(db, r)

    # ---- 来源渠道 / 备注（与「编辑预订」共用 helper）----
    apply_channel_and_notes_changes(db, r, body.channel_id, body.notes, changes)

    if not changes:
        return res_out(db, r)

    log_op(db, r.hotel_id, user, "reservation_edit", "reservation", r.id,
           f"编辑在住登记 {r.code}（{g.name if g else ''}）：{' · '.join(changes)}")
    db.commit()
    return res_out(db, r)


# ---------- 撤销入住（入住反向：退回已确认、房态转空脏，已收款保留） ----------
@router.post("/{res_id}/undo-check-in")
def undo_check_in(res_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (not can_access_hotel(db, user, r.hotel_id)):
        raise HTTPException(404, "预订不存在")
    if r.status != "checked_in":
        raise HTTPException(400, "仅「在住」预订可撤销入住")

    g = db.get(Guest, r.guest_id)
    room = db.get(Room, r.room_id) if r.room_id else None
    paid_total = money(sum(p.amount for p in db.query(Payment).filter(Payment.reservation_id == r.id).all()))

    # 款项保留：只有「取消预订」才清除已收款（撤销入住/撤销退房均不动 payments）
    r.status = "confirmed"
    r.actual_check_in = None  # 到时提醒口径随之失效；再入住会重新写入

    # 同房还有其他在住客人（前客未退场景）时不动房态，否则退回空脏待清洁
    other_guests = []
    if room:
        other_guests = (db.query(Reservation)
                        .filter(Reservation.hotel_id == r.hotel_id,
                                Reservation.room_id == room.id,
                                Reservation.status == "checked_in",
                                Reservation.id != r.id)
                        .all())
    if room and not other_guests:
        room.status = "vacant_dirty"

    log_op(db, r.hotel_id, user, "check_in_undo", "reservation", r.id,
           f"撤销入住 {g.name if g else ''} · {r.code} · {room.room_number if room else '未分配'} · "
           f"退回已确认"
           + (f" · 房态转空脏" if room and not other_guests else " · 同房仍有在住客人，房态不变")
           + (f" · 已收款 ¥{fmt_money(paid_total)} 保留" if paid_total > 0 else ""))
    db.commit()
    return res_out(db, r)


# ---------- 撤销退房（退房反向：回到在住，已收款保留） ----------
@router.post("/{res_id}/undo-check-out")
def undo_check_out(res_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (not can_access_hotel(db, user, r.hotel_id)):
        raise HTTPException(404, "预订不存在")
    if r.status != "checked_out":
        raise HTTPException(400, "仅「已退房」预订可撤销退房")

    g = db.get(Guest, r.guest_id)
    room = db.get(Room, r.room_id) if r.room_id else None
    paid_total = money(sum(p.amount for p in db.query(Payment).filter(Payment.reservation_id == r.id).all()))

    # 提前退房后尾段可能已售出新单：撤销回到在住会重新占满原订区间，重叠则拒绝
    # （前台需先处理新单——改房/改期或取消，再撤销退房）
    if room:
        conflicts = (db.query(Reservation)
                    .filter(Reservation.hotel_id == r.hotel_id,
                            Reservation.room_id == room.id,
                            Reservation.status.in_(["pending", "confirmed", "checked_in"]),
                            Reservation.check_in < r.check_out,
                            Reservation.check_out > r.check_in,
                            Reservation.id != r.id)
                    .all())
        if conflicts:
            detail = "、".join(f"{c.code} {c.check_in:%m/%d}–{c.check_out:%m/%d}" for c in conflicts)
            raise HTTPException(409, detail={
                "message": f"撤销退房后 {room.room_number} 在原住期内已有其他预订（{detail}），请先调整或取消新预订",
                "conflicts": [c.id for c in conflicts],
            })

    r.status = "checked_in"
    # 撤销退房：清除实际离店日（回到在住，方块恢复原订跨度）
    r.actual_check_out = None
    # 房间恢复在住；维修中的房不强行改状态（房态由前台决定），并在日志里注明
    room_kept_maint = False
    if room:
        if room.status == "maintenance":
            room_kept_maint = True
        else:
            room.status = "occupied"

    log_op(db, r.hotel_id, user, "check_out_undo", "reservation", r.id,
           f"撤销退房 {g.name if g else ''} · {r.code} · {room.room_number if room else '未分配'} · 回到在住"
           + (" · 房间维修中，房态保持维修" if room_kept_maint else " · 房态恢复在住")
           + (f" · 已收款 ¥{fmt_money(paid_total)} 保留" if paid_total > 0 else ""))
    db.commit()
    return res_out(db, r)


# ---------- 更正实收（把整单已收金额调整到目标总额） ----------
@router.patch("/{res_id}/paid-total")
def adjust_paid_total(res_id: int, body: PaidTotalBody,
                      user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (not can_access_hotel(db, user, r.hotel_id)):
        raise HTTPException(404, "预订不存在")
    if r.status not in ("checked_in", "checked_out"):
        raise HTTPException(400, "仅「在住 / 已退房」预订可更正实收")
    if body.amount < 0:
        raise HTTPException(400, "实收金额不能为负数")

    pays = (db.query(Payment)
            .filter(Payment.reservation_id == r.id)
            .order_by(Payment.id)
            .all())
    cur = money(sum(p.amount for p in pays))
    target = body.amount
    if target == cur:
        return res_out(db, r)

    if target > cur:
        # 补收差额：新增一笔收款，保留原有逐笔记录
        assert_method_usable(db, r.hotel_id, body.method)
        diff = money(target - cur)
        db.add(Payment(hotel_id=r.hotel_id, reservation_id=r.id,
                       method=body.method, amount=diff, created_by=user.id))
        summary = (f"更正实收 ¥{fmt_money(cur)}→¥{fmt_money(target)}"
                   f"（补收 ¥{fmt_money(diff)} · {pay_method_label(db, r.hotel_id, body.method)}）")
    else:
        # 冲减：从最新一笔起删除，最后一笔按差额部分冲减
        remain = money(cur - target)
        for p in reversed(pays):
            if remain <= 0:
                break
            if p.amount <= remain:
                remain = money(remain - p.amount)
                db.delete(p)
            else:
                p.amount = money(p.amount - remain)
                remain = 0
        summary = (f"更正实收 ¥{fmt_money(cur)}→¥{fmt_money(target)}"
                   f"（冲减 ¥{fmt_money(cur - target)}，无退款凭证）")

    log_op(db, r.hotel_id, user, "payment_adjust", "payment", r.id, summary)
    db.commit()
    return res_out(db, r)


# ---------- 退房结算 ----------
@router.post("/{res_id}/check-out")
def check_out(res_id: int, body: CheckOutBody, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (not can_access_hotel(db, user, r.hotel_id)):
        raise HTTPException(404, "预订不存在")
    if r.status != "checked_in":
        raise HTTPException(400, "仅「在住」预订可办理退房")
    # 未来入住的预订不能退房（与入住同一门槛：入住日当天及之后才可操作）
    if r.check_in > date.today():
        raise HTTPException(400, f"入住日期为 {r.check_in:%m/%d}，尚未到店，不可办理退房")

    # 随退房收取的款项先校验收款方式（本店配置且启用），再计入「收款后余额」判断
    for p in body.payments:
        if p.amount > 0:
            assert_method_usable(db, r.hotel_id, p.method)
    # 本次随退房一并收取的款项先计入，再按「收款后余额」判断是否需要强制退房
    paid_now = money(sum(p.amount for p in body.payments if p.amount > 0))
    bal = money(balance_of(db, r.id) - paid_now)
    if bal > 0 and not body.force:
        raise HTTPException(409, detail={
            "message": "存在未结清账款，请先收款或强制退房",
            "balance_due": bal,
        })

    for p in body.payments:
        if p.amount <= 0:
            continue
        db.add(Payment(hotel_id=r.hotel_id, reservation_id=r.id,
                       method=p.method, amount=money(p.amount), remark=(p.remark or "").strip(),
                       created_by=user.id))
        log_op(db, r.hotel_id, user, "payment", "payment", r.id,
               f"收款 ¥{fmt_money(p.amount)} · {pay_method_label(db, r.hotel_id, p.method)}{_remark_suffix(p.remark)}")

    r.status = "checked_out"
    # 记录实际离店日（提前退房时早于 check_out，房态盘据此截断灰块并放出尾部「可售」）
    r.actual_check_out = date.today()
    room = db.get(Room, r.room_id) if r.room_id else None
    # 功能放宽后同房可能有另一位在住客人：此时退房不动房态
    other_guests = []
    if room:
        other_guests = (db.query(Reservation)
                        .filter(Reservation.hotel_id == r.hotel_id,
                                Reservation.room_id == room.id,
                                Reservation.status == "checked_in",
                                Reservation.id != r.id)
                        .all())
    if room and not other_guests:
        # 退房 → 房态转空脏；由前台在房态盘点「设净」恢复为净房
        room.status = "vacant_dirty"
    g = db.get(Guest, r.guest_id)
    bal_after = balance_of(db, r.id)
    log_op(db, r.hotel_id, user, "check_out", "reservation", r.id,
           f"退房结算 {g.name if g else ''} · {room.room_number if room else ''} · "
           f"{'结清' if bal_after <= 0 else f'未结清 ¥{fmt_money(bal_after)}'}"
           + (" · 房态转空脏" if room and not other_guests else " · 同房仍有在住客人，房态不变"))
    db.commit()
    return res_out(db, r)


# ---------- 延住（自定义天数/价格，追加账目不改原房费） ----------
@router.post("/{res_id}/extend")
def extend_reservation(res_id: int, body: ExtendBody,
                       user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (not can_access_hotel(db, user, r.hotel_id)):
        raise HTTPException(404, "预订不存在")
    if r.status != "checked_in":
        raise HTTPException(400, "仅「在住」预订可延住")
    if body.nights < 0 or body.hours < 0:
        raise HTTPException(400, "延住晚数/小时数不能为负")
    rate = body.rate if body.rate is not None else r.rate
    if rate < 0:
        raise HTTPException(400, "延住价格不能为负数")

    if r.stay_type == "hourly":
        # 钟点房按小时延长：离店日不变（占整日），时长与账目累加
        if body.hours <= 0:
            raise HTTPException(400, "请输入延住小时数")
        new_hours = r.hours + body.hours
        if new_hours > 12:
            raise HTTPException(400, "钟点房时长累计不可超过 12 小时")
        r.hours = new_hours
        amount = money(body.hours * rate)
        desc = f"延住房费 · {body.hours} 小时 × ¥{fmt_money(rate)}"
    else:
        if body.hours:
            raise HTTPException(400, "仅钟点房可按小时延住")
        if body.nights <= 0:
            raise HTTPException(400, "请输入延住晚数")
        new_out = r.check_out + timedelta(days=body.nights)
        # 冲突只按未到店预订计（checked_in 不阻挡，与入住放宽口径一致）
        if r.room_id:
            conflict = blocking_ids(db, r.hotel_id, r.room_id, r.check_in, new_out,
                                    exclude=r.id, include_checked_in=False)
            if conflict:
                room = db.get(Room, r.room_id)
                raise HTTPException(409, f"{room.room_number if room else '客房'} 延住时段已被其他预订占用")
        r.check_out = new_out
        amount = money(body.nights * rate)
        desc = f"延住房费 · {body.nights} 晚 × ¥{fmt_money(rate)}"

    db.add(FolioItem(hotel_id=r.hotel_id, reservation_id=r.id,
                     category="room_charge", description=desc,
                     amount=amount, created_by=user.id))
    db.flush()
    g = db.get(Guest, r.guest_id)
    unit = f"{body.hours} 小时" if r.stay_type == "hourly" else f"{body.nights} 晚"
    log_op(db, r.hotel_id, user, "reservation_extend", "reservation", r.id,
           f"延住 {g.name if g else ''} · {r.code}：+{unit} × ¥{fmt_money(rate)}，应收 ¥{fmt_money(amount)}，"
           f"{'时长 ' + str(r.hours) + ' 小时' if r.stay_type == 'hourly' else '新离店 ' + format(r.check_out, '%m/%d')}")
    db.commit()
    return res_out(db, r)


# ---------- 存量连住手动合并（把逐笔开的单并成一笔普通多晚订单） ----------
@router.post("/merge-chain")
def merge_chain(body: MergeChainBody,
                user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """同一客人同房首尾相接的多笔并成一笔：保留最早那笔（订单号不变），
    其余各笔的房费 / 收款 / 操作日志迁到存活单后删除。

    这是给「历史上已逐笔开出的单」补一刀的入口——从此开单时 POST /api/reservations
    会自动并入（见 join_chain_target），日常前台不需要手动调它。
    已退房 / 已取消 / 钟点房 / 状态不一致 / 不相邻 一律 400（历史账目口径不动）。"""
    ids = list(dict.fromkeys(body.ids))     # 去重保序
    if len(ids) < 2:
        raise HTTPException(400, "至少选择两笔预订才能合并")
    rows: list[Reservation] = []
    for rid in ids:
        r = db.get(Reservation, rid)
        if not r or (not can_access_hotel(db, user, r.hotel_id)):
            raise HTTPException(404, "预订不存在")
        rows.append(r)

    hotel_id = rows[0].hotel_id
    if any(r.hotel_id != hotel_id for r in rows):
        raise HTTPException(400, "不同酒店的预订不可合并")
    if any(r.stay_type != "normal" for r in rows):
        raise HTTPException(400, "钟点房按小时计，不可与整晚订单合并")
    if any(r.status not in ("pending", "confirmed", "checked_in") for r in rows):
        raise HTTPException(400, "仅待确认 / 已确认 / 在住的预订可合并（已退房订单已结清，不可合并）")
    if len({r.status for r in rows}) > 1:
        raise HTTPException(400, "状态不一致的预订不可合并（请先统一为同一种状态）")
    if len({r.guest_id for r in rows}) > 1:
        raise HTTPException(400, "不同客人的预订不可合并")
    if len({r.room_id for r in rows}) > 1:
        raise HTTPException(400, "不同客房的预订不可合并")
    if len({r.channel_id for r in rows}) > 1:
        raise HTTPException(400, "来源不同的预订不可合并")
    if len({r.room_type_id for r in rows}) > 1:
        raise HTTPException(400, "房型不同的预订不可合并")

    rows.sort(key=lambda x: (x.check_in, x.id))
    for prev, nxt in zip(rows, rows[1:]):
        if prev.check_out != nxt.check_in:
            raise HTTPException(
                400, f"预订不连续：{prev.check_out:%m/%d} 与 {nxt.check_in:%m/%d} 之间有断档")
    # 在住单并进来时，房间必须确实在住着——否则整单变成在住却没客人（口径兜底）
    if rows[0].status == "checked_in" and rows[0].room_id:
        other_in = (db.query(Reservation)
                    .filter(Reservation.hotel_id == hotel_id,
                            Reservation.room_id == rows[0].room_id,
                            Reservation.status == "checked_in",
                            Reservation.id.notin_([r.id for r in rows]))
                    .count())
        if other_in:
            raise HTTPException(400, "该房还有其他在住预订，请先处理后再合并")

    keep, rest = rows[0], rows[1:]
    keep.check_out = rows[-1].check_out
    moved_paid = 0.0
    moved_charge = 0.0
    codes: list[str] = []
    for r in rest:
        codes.append(r.code)
        moved_charge += room_charge_total_of(db, r.id)
        for p in db.query(Payment).filter(Payment.reservation_id == r.id).all():
            moved_paid += p.amount
            p.reservation_id = keep.id
        db.query(FolioItem).filter(FolioItem.reservation_id == r.id) \
            .update({FolioItem.reservation_id: keep.id}, synchronize_session=False)
        # 操作留痕跟着走：payment 类日志的 object_id 存的也是预订 id
        db.query(OperationLog) \
            .filter(OperationLog.hotel_id == hotel_id,
                    OperationLog.object_id == r.id,
                    OperationLog.object_type.in_(["reservation", "payment"])) \
            .update({OperationLog.object_id: keep.id}, synchronize_session=False)
        keep.notes = _notes_append(keep.notes, r.notes)
        db.delete(r)
    db.flush()

    g = db.get(Guest, keep.guest_id)
    log_op(db, hotel_id, user, "reservation_merge", "reservation", keep.id,
           f"合并连住 {g.name if g else ''} · {keep.code}：并入 {'、'.join(codes)}，"
           f"住期 {keep.check_in:%m/%d}–{keep.check_out:%m/%d}，"
           f"房费合计 ¥{fmt_money(room_charge_total_of(db, keep.id))}（含并入 ¥{fmt_money(moved_charge)}）"
           + (f"，迁移收款 ¥{fmt_money(moved_paid)}" if moved_paid > 0 else ""))
    db.commit()
    return res_out(db, keep, merged=True)


# ---------- 预订操作日志（详情弹层展开区） ----------
@router.get("/{res_id}/logs")
def reservation_logs(res_id: int,
                     user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (not can_access_hotel(db, user, r.hotel_id)):
        raise HTTPException(404, "预订不存在")
    # payment 类日志的 object_id 同样存预订 id，一并纳入
    ops = (db.query(OperationLog)
           .filter(OperationLog.hotel_id == r.hotel_id,
                   OperationLog.object_id == r.id,
                   OperationLog.object_type.in_(["reservation", "payment"]))
           .order_by(OperationLog.created_at.desc(), OperationLog.id.desc())
           .limit(100)
           .all())
    return [{
        "id": o.id,
        "time": o.created_at.strftime("%m-%d %H:%M"),
        "action": o.action,
        "summary": o.summary,
        "operator": o.operator_name or "系统",
    } for o in ops]


# ---------- 详情（房态盘 / 前台弹层依赖） ----------
@router.get("/{res_id}")
def get_reservation(res_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (not can_access_hotel(db, user, r.hotel_id)):
        raise HTTPException(404, "预订不存在")
    return res_out(db, r)


# ---------- 账目 / 收款 ----------
@router.get("/{res_id}/folio")
def get_folio(res_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (not can_access_hotel(db, user, r.hotel_id)):
        raise HTTPException(404, "预订不存在")
    items = db.query(FolioItem).filter(FolioItem.reservation_id == res_id).order_by(FolioItem.created_at, FolioItem.id).all()
    pays = db.query(Payment).filter(Payment.reservation_id == res_id).order_by(Payment.created_at, Payment.id).all()
    users = {u.id: u.name for u in db.query(User).filter(User.hotel_id == r.hotel_id).all()}
    return {
        "items": [{
            "id": x.id, "category": x.category, "description": x.description,
            "amount": x.amount, "created_at": x.created_at.isoformat(),
            "operator": users.get(x.created_by, ""),
        } for x in items],
        "payments": [{
            "id": x.id, "method": x.method, "amount": x.amount, "remark": x.remark,
            "created_at": x.created_at.isoformat(), "operator": users.get(x.created_by, ""),
        } for x in pays],
        "total_charge": money(sum(x.amount for x in items)),
        "total_paid": money(sum(x.amount for x in pays)),
        "balance_due": balance_of(db, res_id),
    }


@router.post("/{res_id}/folio-items")
def add_folio_item(res_id: int, body: FolioItemBody,
                   user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (not can_access_hotel(db, user, r.hotel_id)):
        raise HTTPException(404, "预订不存在")
    if r.status not in ("checked_in", "confirmed", "pending"):
        raise HTTPException(400, "当前状态不可加收费用")
    item = FolioItem(hotel_id=r.hotel_id, reservation_id=r.id,
                     category=body.category, description=body.description,
                     amount=money(body.amount), created_by=user.id)
    db.add(item)
    db.flush()
    log_op(db, r.hotel_id, user, "folio_add", "reservation", r.id,
           f"加收{dict(room_charge='房费', other='杂费')[body.category]} {body.description} ¥{fmt_money(body.amount)}")
    db.commit()
    return {"ok": True, "balance_due": balance_of(db, res_id)}


@router.post("/{res_id}/payments")
def add_payment(res_id: int, body: PaymentBody,
                user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (not can_access_hotel(db, user, r.hotel_id)):
        raise HTTPException(404, "预订不存在")
    if body.amount <= 0:
        raise HTTPException(400, "收款金额需大于 0")
    remark = (body.remark or "").strip()
    if len(remark) > 120:
        raise HTTPException(400, "备注最多 120 字")
    assert_method_usable(db, r.hotel_id, body.method)
    pay = Payment(hotel_id=r.hotel_id, reservation_id=r.id,
                  method=body.method, amount=money(body.amount), remark=remark, created_by=user.id)
    db.add(pay)
    db.flush()
    log_op(db, r.hotel_id, user, "payment", "payment", r.id,
           f"收款 ¥{fmt_money(body.amount)} · {pay_method_label(db, r.hotel_id, body.method)}{_remark_suffix(remark)}")
    db.commit()
    return {"ok": True, "balance_due": balance_of(db, res_id)}


@router.delete("/{res_id}/payments/{payment_id}")
def delete_payment(res_id: int, payment_id: int,
                   user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """按笔删除收款（订单详情收款表行内删除 / 预订列表删错押金）：
    全状态放行（pending/confirmed 的预收款收错可直接删，cancelled 由取消预订统一清除不再单独删）。
    物理删除该笔 Payment，写 payment_delete 日志（object_type=payment，object_id 存预订 id）。"""
    r = db.get(Reservation, res_id)
    if not r or (not can_access_hotel(db, user, r.hotel_id)):
        raise HTTPException(404, "预订不存在")
    if r.status == "cancelled":
        raise HTTPException(400, "已取消预订的款项不可单独删除（取消时已统一清除）")
    pay = db.get(Payment, payment_id)
    if not pay or pay.reservation_id != res_id:
        raise HTTPException(404, "收款记录不存在")
    amount, method, remark = pay.amount, pay.method, pay.remark
    db.delete(pay)
    log_op(db, r.hotel_id, user, "payment_delete", "payment", r.id,
           f"删除收款 ¥{fmt_money(amount)} · {pay_method_label(db, r.hotel_id, method)}{_remark_suffix(remark)}")
    db.commit()
    return {"ok": True, "balance_due": balance_of(db, res_id)}
