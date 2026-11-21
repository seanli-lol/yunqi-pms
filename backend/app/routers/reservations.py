"""预订全流程：创建（按房型或锁定房号）、拖动改期/换房、入住、退房结算、账目与收款"""
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import (balance_of, blocking_ids, free_rooms, get_current_user,
                      log_op, resolve_hotel_id)
from app.models import (Channel, FolioItem, Guest, OperationLog,
                        Payment, Reservation, Room, RoomType, User)
from app.schemas import (CheckInBody, CheckOutBody, ExtendBody, FolioItemBody,
                         PaidTotalBody, PaymentBody, RegistrationBody,
                         ReservationBody, ReservationOut, ReservationPatch)
from app.routers.payment_methods import assert_method_usable, pay_method_label

router = APIRouter(prefix="/api/reservations", tags=["reservations"])


def _remark_suffix(remark: str) -> str:
    """收款日志摘要的备注后缀（非空才追加；删除收款时记录被物理删除，日志必须留痕原文）"""
    remark = (remark or "").strip()
    return f" · 备注「{remark}」" if remark else ""


# ---------- 序列化 ----------
def res_out(db: Session, r: Reservation) -> ReservationOut:
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
        balance_due=max(0, balance_of(db, r.id)),
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
    """按当前房价与住期重算首条房费账目（延住追加行不参与，沿用既有边界）。"""
    fee = (db.query(FolioItem)
           .filter(FolioItem.reservation_id == r.id, FolioItem.category == "room_charge")
           .order_by(FolioItem.id)
           .first())
    if not fee:
        return
    if r.stay_type == "hourly":
        fee.amount = r.hours * r.rate
        fee.description = f"钟点房费 · {r.hours} 小时 × ¥{r.rate}"
    else:
        nights = (r.check_out - r.check_in).days
        fee.amount = nights * r.rate
        fee.description = f"房费 · {nights} 晚 × ¥{r.rate}"


def upsert_guest(db: Session, hotel_id: int, name: str, phone: str, id_number: str) -> Guest:
    g = None
    if phone:
        g = db.query(Guest).filter(Guest.hotel_id == hotel_id, Guest.phone == phone).first()
    if g is None and not phone:
        g = db.query(Guest).filter(Guest.hotel_id == hotel_id, Guest.name == name).first()
    if g is None:
        # 新建档前校验证件号：同店已有档案用该证件号说明是老客，应走客人联想选中已有档案
        if id_number.strip():
            dup = (db.query(Guest)
                   .filter(Guest.hotel_id == hotel_id,
                           Guest.id_number == id_number.strip())
                   .first())
            if dup:
                raise HTTPException(
                    400, f"证件号已属于客户档案「{dup.name}」，请在客人联想中选择该档案")
        g = Guest(hotel_id=hotel_id, name=name.strip(), phone=phone.strip(),
                  id_number=id_number.strip())
        db.add(g)
        db.flush()
    else:
        if id_number and not g.id_number:
            g.id_number = id_number.strip()
    return g


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
    hid = resolve_hotel_id(user, hotel_id)
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
    hid = resolve_hotel_id(user, hotel_id)
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
        if blocking_ids(db, hid, room.id, check_in, check_out):
            raise HTTPException(409, f"{room.room_number} 所选时段已被占用")
        rt = db.get(RoomType, room.room_type_id)
        rate = body.rate if body.rate is not None else rt.base_price
        room_type_id = rt.id
    else:
        # 按房型预订：校验可售数量
        if not body.room_type_id:
            raise HTTPException(400, "请选择房型或指定房号")
        rt = db.get(RoomType, body.room_type_id)
        if not rt or rt.hotel_id != hid:
            raise HTTPException(400, "房型不存在")
        free = free_rooms(db, hid, rt.id, check_in, check_out)
        if not free:
            raise HTTPException(409, "所选房型该时段已满房")
        room = free[0]  # 预留空净房；入住时允许改派
        rate = body.rate if body.rate is not None else rt.base_price
        room_type_id = rt.id

    if body.stay_type == "hourly":
        # 铁律：房型未配置钟点价（hourly_price=0）不可按钟点房售卖——显式传价也不放行
        hourly = rt.hourly_price if rt else 0
        if not hourly:
            raise HTTPException(400, f"房型「{rt.name if rt else ''}」未配置钟点价，不能按钟点房售卖，请先在设置 → 房型 中配置")
        if body.rate is None:
            rate = hourly
        elif rate <= 0:
            raise HTTPException(400, "请设置钟点房价")

    if body.channel_id:
        ch = db.get(Channel, body.channel_id)
        if not ch or ch.hotel_id != hid:
            raise HTTPException(400, "来源渠道不存在")

    guest = upsert_guest(db, hid, body.guest_name, body.guest_phone, body.guest_id_number)
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
        fee_desc = f"钟点房费 · {hours} 小时 × ¥{rate}"
        fee_amount = hours * rate
    else:
        fee_desc = f"房费 · {nights} 晚 × ¥{rate}"
        fee_amount = nights * rate
    db.add(FolioItem(
        hotel_id=hid, reservation_id=r.id, category="room_charge",
        description=fee_desc,
        amount=fee_amount, created_by=user.id,
    ))
    stay_tag = " · 钟点" if body.stay_type == "hourly" else ""
    log_op(db, hid, user, "reservation_create", "reservation", r.id,
           f"创建预订 {r.code} · {guest.name} · {rt.name}{(' · ' + room.room_number + ' 房') if room else ''} · {check_in:%m/%d}–{check_out:%m/%d}{stay_tag}")
    db.commit()
    return res_out(db, r)


# ---------- 拖动改期 / 换房 / 调整预订（日期、房价） ----------
@router.patch("/{res_id}")
def move_reservation(res_id: int, body: ReservationPatch,
                     user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (user.role != "platform_admin" and r.hotel_id != user.hotel_id):
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

    # 同步房费账目（按新晚数 / 新房价重算第一条房费）
    # ⚠️ 已知边界：延住（POST /extend）追加的「延住房费」行不参与重算——若先延住再拖动改期，
    # 首条房费按新晚数整体重算，叠加延住行会双重计费；前台应优先用延住入口调整在住住期。
    # 钟点预订不按晚重算（账目 = 小时 × 单价，换房不影响）。
    if span_changed or rate_changed:
        recalc_room_charge(db, r)

    detail = []
    if room_changed:
        detail.append(f"{old_room.room_number if old_room else '—'} → {room.room_number if room else '—'}")
    if span_changed:
        detail.append(f"{cin:%m/%d}–{cout:%m/%d}")
    if rate_changed:
        detail.append(f"房价 ¥{body.rate}/晚")
    guest = db.get(Guest, r.guest_id)
    log_op(db, r.hotel_id, user, "reservation_move", "reservation", r.id,
           f"调整预订 {r.code}（{guest.name if guest else ''}）：{' · '.join(detail) or '无变化'}")
    db.commit()
    return res_out(db, r)


# ---------- 确认 ----------
@router.post("/{res_id}/confirm")
def confirm_reservation(res_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (user.role != "platform_admin" and r.hotel_id != user.hotel_id):
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
    if not r or (user.role != "platform_admin" and r.hotel_id != user.hotel_id):
        raise HTTPException(404, "预订不存在")
    if r.status not in ("pending", "confirmed"):
        raise HTTPException(400, "仅待确认 / 已确认的预订可取消")
    r.status = "cancelled"
    # 取消是整条流转里唯一清除已收款的环节（撤销入住 / 撤销退房都保留款项）
    pays = db.query(Payment).filter(Payment.reservation_id == r.id).all()
    paid_total = sum(p.amount for p in pays)
    for p in pays:
        db.delete(p)
    g = db.get(Guest, r.guest_id)
    if paid_total > 0:
        log_op(db, r.hotel_id, user, "payment", "payment", r.id,
               f"取消预订清除收款 ¥{paid_total}（共 {len(pays)} 笔，无退款凭证）")
    log_op(db, r.hotel_id, user, "reservation_cancel", "reservation", r.id,
           f"取消预订 {r.code}（{g.name if g else ''}）"
           + (f" · 清除已收款 ¥{paid_total}" if paid_total > 0 else ""))
    db.commit()
    return res_out(db, r)


# ---------- 入住 ----------
@router.post("/{res_id}/check-in")
def check_in(res_id: int, body: CheckInBody, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (user.role != "platform_admin" and r.hotel_id != user.hotel_id):
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
    room.status = "occupied"

    if body.amount_received > 0:
        assert_method_usable(db, r.hotel_id, body.payment_method)
        db.add(Payment(hotel_id=r.hotel_id, reservation_id=r.id,
                       method=body.payment_method, amount=body.amount_received, created_by=user.id))
        log_op(db, r.hotel_id, user, "payment", "payment", r.id,
               f"入住实收 ¥{body.amount_received} · {pay_method_label(db, r.hotel_id, body.payment_method)}")
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
    if not r or (user.role != "platform_admin" and r.hotel_id != user.hotel_id):
        raise HTTPException(404, "预订不存在")
    if r.status != "checked_in":
        raise HTTPException(400, "仅「在住」预订可编辑登记信息")

    g = db.get(Guest, r.guest_id)
    changes: list[str] = []

    # ---- 客人姓名 / 手机号：同步客户档案 ----
    new_name = body.guest_name.strip() if body.guest_name is not None else None
    new_phone = body.guest_phone.strip() if body.guest_phone is not None else None
    if new_name is not None and not new_name:
        raise HTTPException(400, "客人姓名不能为空")
    if new_phone is not None and new_phone:
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
        changes.append(f"房价 ¥{r.rate}→¥{body.rate}")
        r.rate = body.rate
    if rate_changed or body.nights is not None:
        recalc_room_charge(db, r)

    # ---- 来源渠道 ----
    if body.channel_id is not None and body.channel_id != r.channel_id:
        ch = db.get(Channel, body.channel_id)
        if not ch or ch.hotel_id != r.hotel_id:
            raise HTTPException(400, "来源渠道不存在")
        old = db.get(Channel, r.channel_id) if r.channel_id else None
        changes.append(f"来源 {old.name if old else '未填'}→{ch.name}")
        r.channel_id = ch.id

    # ---- 备注 ----
    if body.notes is not None and body.notes != r.notes:
        changes.append(f"备注「{r.notes or '空'}」→「{body.notes or '空'}」")
        r.notes = body.notes

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
    if not r or (user.role != "platform_admin" and r.hotel_id != user.hotel_id):
        raise HTTPException(404, "预订不存在")
    if r.status != "checked_in":
        raise HTTPException(400, "仅「在住」预订可撤销入住")

    g = db.get(Guest, r.guest_id)
    room = db.get(Room, r.room_id) if r.room_id else None
    paid_total = sum(p.amount for p in db.query(Payment).filter(Payment.reservation_id == r.id).all())

    # 款项保留：只有「取消预订」才清除已收款（撤销入住/撤销退房均不动 payments）
    r.status = "confirmed"

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
           + (f" · 已收款 ¥{paid_total} 保留" if paid_total > 0 else ""))
    db.commit()
    return res_out(db, r)


# ---------- 撤销退房（退房反向：回到在住，已收款保留） ----------
@router.post("/{res_id}/undo-check-out")
def undo_check_out(res_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (user.role != "platform_admin" and r.hotel_id != user.hotel_id):
        raise HTTPException(404, "预订不存在")
    if r.status != "checked_out":
        raise HTTPException(400, "仅「已退房」预订可撤销退房")

    g = db.get(Guest, r.guest_id)
    room = db.get(Room, r.room_id) if r.room_id else None
    paid_total = sum(p.amount for p in db.query(Payment).filter(Payment.reservation_id == r.id).all())

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
           + (f" · 已收款 ¥{paid_total} 保留" if paid_total > 0 else ""))
    db.commit()
    return res_out(db, r)


# ---------- 更正实收（把整单已收金额调整到目标总额） ----------
@router.patch("/{res_id}/paid-total")
def adjust_paid_total(res_id: int, body: PaidTotalBody,
                      user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (user.role != "platform_admin" and r.hotel_id != user.hotel_id):
        raise HTTPException(404, "预订不存在")
    if r.status not in ("checked_in", "checked_out"):
        raise HTTPException(400, "仅「在住 / 已退房」预订可更正实收")
    if body.amount < 0:
        raise HTTPException(400, "实收金额不能为负数")

    pays = (db.query(Payment)
            .filter(Payment.reservation_id == r.id)
            .order_by(Payment.id)
            .all())
    cur = sum(p.amount for p in pays)
    target = body.amount
    if target == cur:
        return res_out(db, r)

    if target > cur:
        # 补收差额：新增一笔收款，保留原有逐笔记录
        assert_method_usable(db, r.hotel_id, body.method)
        diff = target - cur
        db.add(Payment(hotel_id=r.hotel_id, reservation_id=r.id,
                       method=body.method, amount=diff, created_by=user.id))
        summary = f"更正实收 ¥{cur}→¥{target}（补收 ¥{diff} · {pay_method_label(db, r.hotel_id, body.method)}）"
    else:
        # 冲减：从最新一笔起删除，最后一笔按差额部分冲减
        remain = cur - target
        for p in reversed(pays):
            if remain <= 0:
                break
            if p.amount <= remain:
                remain -= p.amount
                db.delete(p)
            else:
                p.amount -= remain
                remain = 0
        summary = f"更正实收 ¥{cur}→¥{target}（冲减 ¥{cur - target}，无退款凭证）"

    log_op(db, r.hotel_id, user, "payment_adjust", "payment", r.id, summary)
    db.commit()
    return res_out(db, r)


# ---------- 退房结算 ----------
@router.post("/{res_id}/check-out")
def check_out(res_id: int, body: CheckOutBody, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (user.role != "platform_admin" and r.hotel_id != user.hotel_id):
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
    paid_now = sum(p.amount for p in body.payments if p.amount > 0)
    bal = balance_of(db, r.id) - paid_now
    if bal > 0 and not body.force:
        raise HTTPException(409, detail={
            "message": "存在未结清账款，请先收款或强制退房",
            "balance_due": bal,
        })

    for p in body.payments:
        if p.amount <= 0:
            continue
        db.add(Payment(hotel_id=r.hotel_id, reservation_id=r.id,
                       method=p.method, amount=p.amount, remark=(p.remark or "").strip(),
                       created_by=user.id))
        log_op(db, r.hotel_id, user, "payment", "payment", r.id,
               f"收款 ¥{p.amount} · {pay_method_label(db, r.hotel_id, p.method)}{_remark_suffix(p.remark)}")

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
           f"{'结清' if bal_after <= 0 else f'未结清 ¥{bal_after}'}"
           + (" · 房态转空脏" if room and not other_guests else " · 同房仍有在住客人，房态不变"))
    db.commit()
    return res_out(db, r)


# ---------- 延住（自定义天数/价格，追加账目不改原房费） ----------
@router.post("/{res_id}/extend")
def extend_reservation(res_id: int, body: ExtendBody,
                       user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (user.role != "platform_admin" and r.hotel_id != user.hotel_id):
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
        amount = body.hours * rate
        desc = f"延住房费 · {body.hours} 小时 × ¥{rate}"
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
        amount = body.nights * rate
        desc = f"延住房费 · {body.nights} 晚 × ¥{rate}"

    db.add(FolioItem(hotel_id=r.hotel_id, reservation_id=r.id,
                     category="room_charge", description=desc,
                     amount=amount, created_by=user.id))
    db.flush()
    g = db.get(Guest, r.guest_id)
    unit = f"{body.hours} 小时" if r.stay_type == "hourly" else f"{body.nights} 晚"
    log_op(db, r.hotel_id, user, "reservation_extend", "reservation", r.id,
           f"延住 {g.name if g else ''} · {r.code}：+{unit} × ¥{rate}，应收 ¥{amount}，"
           f"{'时长 ' + str(r.hours) + ' 小时' if r.stay_type == 'hourly' else '新离店 ' + format(r.check_out, '%m/%d')}")
    db.commit()
    return res_out(db, r)


# ---------- 预订操作日志（详情弹层展开区） ----------
@router.get("/{res_id}/logs")
def reservation_logs(res_id: int,
                     user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (user.role != "platform_admin" and r.hotel_id != user.hotel_id):
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
    if not r or (user.role != "platform_admin" and r.hotel_id != user.hotel_id):
        raise HTTPException(404, "预订不存在")
    return res_out(db, r)


# ---------- 账目 / 收款 ----------
@router.get("/{res_id}/folio")
def get_folio(res_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (user.role != "platform_admin" and r.hotel_id != user.hotel_id):
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
        "total_charge": sum(x.amount for x in items),
        "total_paid": sum(x.amount for x in pays),
        "balance_due": balance_of(db, res_id),
    }


@router.post("/{res_id}/folio-items")
def add_folio_item(res_id: int, body: FolioItemBody,
                   user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (user.role != "platform_admin" and r.hotel_id != user.hotel_id):
        raise HTTPException(404, "预订不存在")
    if r.status not in ("checked_in", "confirmed", "pending"):
        raise HTTPException(400, "当前状态不可加收费用")
    item = FolioItem(hotel_id=r.hotel_id, reservation_id=r.id,
                     category=body.category, description=body.description,
                     amount=body.amount, created_by=user.id)
    db.add(item)
    db.flush()
    log_op(db, r.hotel_id, user, "folio_add", "reservation", r.id,
           f"加收{dict(room_charge='房费', other='杂费')[body.category]} {body.description} ¥{body.amount}")
    db.commit()
    return {"ok": True, "balance_due": balance_of(db, res_id)}


@router.post("/{res_id}/payments")
def add_payment(res_id: int, body: PaymentBody,
                user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (user.role != "platform_admin" and r.hotel_id != user.hotel_id):
        raise HTTPException(404, "预订不存在")
    if body.amount <= 0:
        raise HTTPException(400, "收款金额需大于 0")
    remark = (body.remark or "").strip()
    if len(remark) > 120:
        raise HTTPException(400, "备注最多 120 字")
    assert_method_usable(db, r.hotel_id, body.method)
    pay = Payment(hotel_id=r.hotel_id, reservation_id=r.id,
                  method=body.method, amount=body.amount, remark=remark, created_by=user.id)
    db.add(pay)
    db.flush()
    log_op(db, r.hotel_id, user, "payment", "payment", r.id,
           f"收款 ¥{body.amount} · {pay_method_label(db, r.hotel_id, body.method)}{_remark_suffix(remark)}")
    db.commit()
    return {"ok": True, "balance_due": balance_of(db, res_id)}


@router.delete("/{res_id}/payments/{payment_id}")
def delete_payment(res_id: int, payment_id: int,
                   user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """按笔删除收款（订单详情收款表行内删除）：
    口径对齐 paid-total——仅「在住 / 已退房」可操作；pending/confirmed 的款项走取消预订统一清除。
    物理删除该笔 Payment，写 payment_delete 日志（object_type=payment，object_id 存预订 id）。"""
    r = db.get(Reservation, res_id)
    if not r or (user.role != "platform_admin" and r.hotel_id != user.hotel_id):
        raise HTTPException(404, "预订不存在")
    if r.status not in ("checked_in", "checked_out"):
        raise HTTPException(400, "仅「在住 / 已退房」预订可删除收款记录")
    pay = db.get(Payment, payment_id)
    if not pay or pay.reservation_id != res_id:
        raise HTTPException(404, "收款记录不存在")
    amount, method, remark = pay.amount, pay.method, pay.remark
    db.delete(pay)
    log_op(db, r.hotel_id, user, "payment_delete", "payment", r.id,
           f"删除收款 ¥{amount} · {pay_method_label(db, r.hotel_id, method)}{_remark_suffix(remark)}")
    db.commit()
    return {"ok": True, "balance_due": balance_of(db, res_id)}
