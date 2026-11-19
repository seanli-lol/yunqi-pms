"""预订全流程：创建（按房型或锁定房号）、拖动改期/换房、入住、退房结算、账目与收款"""
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import (balance_of, blocking_ids, free_rooms, get_current_user,
                      log_op, resolve_hotel_id)
from app.models import (Channel, FolioItem, Guest, HousekeepingTask, Payment,
                        Reservation, Room, RoomType, User)
from app.schemas import (CheckInBody, CheckOutBody, FolioItemBody,
                         PaymentBody, ReservationBody, ReservationOut,
                         ReservationPatch)

router = APIRouter(prefix="/api/reservations", tags=["reservations"])


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
        check_in=r.check_in, check_out=r.check_out,
        nights=nights,
        status=r.status,
        channel_id=r.channel_id,
        channel_name=ch.name if ch else None,
        channel_color=ch.color if ch else None,
        rate=r.rate, notes=r.notes,
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


def upsert_guest(db: Session, hotel_id: int, name: str, phone: str, id_number: str) -> Guest:
    g = None
    if phone:
        g = db.query(Guest).filter(Guest.hotel_id == hotel_id, Guest.phone == phone).first()
    if g is None and not phone:
        g = db.query(Guest).filter(Guest.hotel_id == hotel_id, Guest.name == name).first()
    if g is None:
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
    nights = (body.check_out - body.check_in).days

    room = None
    rt = None
    if body.room_id:
        # 直接预订：锁定房号
        room = db.get(Room, body.room_id)
        if not room or room.hotel_id != hid:
            raise HTTPException(400, "客房不存在")
        if room.status == "maintenance":
            raise HTTPException(400, f"{room.room_number} 维修中，不可预订")
        if blocking_ids(db, hid, room.id, body.check_in, body.check_out):
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
        free = free_rooms(db, hid, rt.id, body.check_in, body.check_out)
        if not free:
            raise HTTPException(409, "所选房型该时段已满房")
        room = free[0]  # 预留空净房；入住时允许改派
        rate = body.rate if body.rate is not None else rt.base_price
        room_type_id = rt.id

    if body.channel_id:
        ch = db.get(Channel, body.channel_id)
        if not ch or ch.hotel_id != hid:
            raise HTTPException(400, "来源渠道不存在")

    guest = upsert_guest(db, hid, body.guest_name, body.guest_phone, body.guest_id_number)
    r = Reservation(
        hotel_id=hid,
        code=gen_code(db, body.check_in),
        guest_id=guest.id,
        room_type_id=room_type_id,
        room_id=room.id if room else None,
        check_in=body.check_in,
        check_out=body.check_out,
        status=body.status,
        channel_id=body.channel_id,
        rate=rate,
        notes=body.notes,
        created_by=user.id,
    )
    db.add(r)
    db.flush()
    # 预生成房费账目（在住挂账可见）
    db.add(FolioItem(
        hotel_id=hid, reservation_id=r.id, category="room_charge",
        description=f"房费 · {nights} 晚 × ¥{rate}",
        amount=nights * rate, created_by=user.id,
    ))
    log_op(db, hid, user, "reservation_create", "reservation", r.id,
           f"创建预订 {r.code} · {guest.name} · {rt.name}{(' · ' + room.room_number + ' 房') if room else ''} · {body.check_in:%m/%d}–{body.check_out:%m/%d}")
    db.commit()
    return res_out(db, r)


# ---------- 拖动改期 / 换房 ----------
@router.patch("/{res_id}")
def move_reservation(res_id: int, body: ReservationPatch,
                     user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Reservation, res_id)
    if not r or (user.role != "platform_admin" and r.hotel_id != user.hotel_id):
        raise HTTPException(404, "预订不存在")
    if r.status not in ("pending", "confirmed", "checked_in"):
        raise HTTPException(400, "当前状态不可调整（仅待确认 / 已确认 / 在住可拖动）")

    cin = body.check_in or r.check_in
    cout = body.check_out or r.check_out
    if cout <= cin:
        raise HTTPException(400, "离店日期必须晚于入住日期")
    new_room_id = body.room_id if body.room_id is not None else r.room_id
    if new_room_id is None:
        raise HTTPException(400, "该预订未锁定房号，请在预订管理中办理")

    room = db.get(Room, new_room_id)
    if not room or room.hotel_id != r.hotel_id:
        raise HTTPException(400, "客房不存在")
    if room.status == "maintenance":
        raise HTTPException(400, f"{room.room_number} 维修中，不可调入")

    conflict = blocking_ids(db, r.hotel_id, room.id, cin, cout, exclude=r.id)
    if conflict:
        raise HTTPException(409, f"{room.room_number} 所选时段已被占用")

    old_room = db.get(Room, r.room_id) if r.room_id else None
    span_changed = (cin, cout) != (r.check_in, r.check_out)
    room_changed = new_room_id != r.room_id

    # 在住预订换房：旧房转空脏并生成清洁任务，新房转为在住
    if r.status == "checked_in" and room_changed and old_room:
        old_room.status = "vacant_dirty"
        db.add(HousekeepingTask(
            hotel_id=r.hotel_id, room_id=old_room.id, task_type="checkout",
            status="pending", priority="high", created_by=user.id,
            notes=f"{r.code} 换房自动生成",
        ))
        room.status = "occupied"

    r.room_id = room.id
    r.check_in = cin
    r.check_out = cout

    # 同步房费账目（按新晚数重算第一条房费）
    nights = (cout - cin).days
    fee = db.query(FolioItem).filter(
        FolioItem.reservation_id == r.id, FolioItem.category == "room_charge").first()
    if fee and nights > 0:
        fee.amount = nights * r.rate
        fee.description = f"房费 · {nights} 晚 × ¥{r.rate}"

    detail = []
    if room_changed:
        detail.append(f"{old_room.room_number if old_room else '—'} → {room.room_number}")
    if span_changed:
        detail.append(f"{cin:%m/%d}–{cout:%m/%d}")
    guest = db.get(Guest, r.guest_id)
    log_op(db, r.hotel_id, user, "reservation_move", "reservation", r.id,
           f"调整预订 {r.code}（{guest.name if guest else ''}）：{' · '.join(detail)}")
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
    g = db.get(Guest, r.guest_id)
    log_op(db, r.hotel_id, user, "reservation_cancel", "reservation", r.id,
           f"取消预订 {r.code}（{g.name if g else ''}）")
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
    room = db.get(Room, body.room_id)
    if not room or room.hotel_id != r.hotel_id:
        raise HTTPException(400, "客房不存在")
    if room.status != "vacant_clean":
        raise HTTPException(400, f"{room.room_number} 当前不是空净房，不可入住")
    # 直接预订已锁定本房时允许房型差异；改派其他房间时房型必须一致
    if body.room_id != r.room_id and room.room_type_id != r.room_type_id:
        raise HTTPException(400, f"{room.room_number} 房型与预订不符")
    if blocking_ids(db, r.hotel_id, room.id, r.check_in, r.check_out, exclude=r.id):
        raise HTTPException(409, f"{room.room_number} 所选时段已被占用")

    # 若原预留了其他空房，不释放（预订记录仍挂最终房号）
    r.room_id = room.id
    r.status = "checked_in"
    room.status = "occupied"

    if body.amount_received > 0:
        db.add(Payment(hotel_id=r.hotel_id, reservation_id=r.id,
                       method=body.payment_method, amount=body.amount_received, created_by=user.id))
        log_op(db, r.hotel_id, user, "payment", "payment", r.id,
               f"入住实收 ¥{body.amount_received} · {dict(cash='现金', wechat='微信', alipay='支付宝', card='刷卡')[body.payment_method]}")
    g = db.get(Guest, r.guest_id)
    rt = db.get(RoomType, r.room_type_id)
    log_op(db, r.hotel_id, user, "check_in", "reservation", r.id,
           f"办理入住 {g.name if g else ''} · {r.code} · 分配 {room.room_number} {rt.name if rt else ''}")
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
                       method=p.method, amount=p.amount, created_by=user.id))
        log_op(db, r.hotel_id, user, "payment", "payment", r.id,
               f"收款 ¥{p.amount} · {dict(cash='现金', wechat='微信', alipay='支付宝', card='刷卡')[p.method]}")

    r.status = "checked_out"
    room = db.get(Room, r.room_id) if r.room_id else None
    if room:
        room.status = "vacant_dirty"
        db.add(HousekeepingTask(
            hotel_id=r.hotel_id, room_id=room.id, task_type="checkout",
            status="pending", priority="high", created_by=user.id,
            notes=f"{r.code} 退房自动生成",
        ))
    g = db.get(Guest, r.guest_id)
    bal_after = balance_of(db, r.id)
    log_op(db, r.hotel_id, user, "check_out", "reservation", r.id,
           f"退房结算 {g.name if g else ''} · {room.room_number if room else ''} · "
           f"{'结清' if bal_after <= 0 else f'未结清 ¥{bal_after}'} · 房态转空脏")
    db.commit()
    return res_out(db, r)


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
            "id": x.id, "method": x.method, "amount": x.amount,
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
    pay = Payment(hotel_id=r.hotel_id, reservation_id=r.id,
                  method=body.method, amount=body.amount, created_by=user.id)
    db.add(pay)
    db.flush()
    log_op(db, r.hotel_id, user, "payment", "payment", r.id,
           f"收款 ¥{body.amount} · {dict(cash='现金', wechat='微信', alipay='支付宝', card='刷卡')[body.method]}")
    db.commit()
    return {"ok": True, "balance_due": balance_of(db, res_id)}
