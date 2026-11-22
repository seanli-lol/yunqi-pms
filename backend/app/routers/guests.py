"""客户档案"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_current_user, log_op, money, resolve_hotel_id
from app.models import Guest, Reservation, Room, User
from app.schemas import GuestBody, GuestDetail, GuestOut, GuestUpdateBody
from app.security import decrypt_field, encrypt_field, mask_id_number

router = APIRouter(prefix="/api/guests", tags=["guests"])


def _dup_check(db: Session, hotel_id: int, *, phone: str | None = None,
               id_number: str | None = None, exclude_id: int | None = None) -> None:
    """同店内手机号/证件号查重：非空才查，撞已有档案直接 400（文案对齐 reservations.registration）。

    手机号明文存储走 SQL 等值；证件号密文存储（随机 nonce 不可 SQL 等值）取本店档案
    解密后内存比对——与列表 q 过滤同款口径，演示级数据量可接受。
    """
    if phone:
        q = db.query(Guest).filter(Guest.hotel_id == hotel_id, Guest.phone == phone)
        if exclude_id:
            q = q.filter(Guest.id != exclude_id)
        dup = q.first()
        if dup:
            raise HTTPException(400, f"手机号已属于客户档案「{dup.name}」，请核对后再改")
    if id_number:
        q = db.query(Guest).filter(Guest.hotel_id == hotel_id)
        if exclude_id:
            q = q.filter(Guest.id != exclude_id)
        for g in q:
            if decrypt_field(g.id_number) == id_number:
                raise HTTPException(400, f"证件号已属于客户档案「{g.name}」，请核对后再改")


@router.get("")
def list_guests(q: str | None = None, vip: str | None = None,
                hotel_id: int | None = None,
                user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    hid = resolve_hotel_id(user, hotel_id)
    guests = db.query(Guest).filter(Guest.hotel_id == hid).order_by(Guest.id).all()
    res_list = db.query(Reservation).filter(
        Reservation.hotel_id == hid,
        Reservation.status.in_(["checked_in", "checked_out"])).all()
    rooms = {r.id: r.room_number for r in db.query(Room).filter(Room.hotel_id == hid).all()}
    by_guest: dict[int, list[Reservation]] = {}
    for r in res_list:
        by_guest.setdefault(r.guest_id, []).append(r)

    out = []
    for g in guests:
        stays = by_guest.get(g.id, [])
        spend = 0
        # 简化：以预订房费+晚数估算累计消费
        for r in stays:
            spend += ((r.check_out - r.check_in).days) * r.rate
        last = max((s.check_in for s in stays), default=None)
        out.append(GuestOut(
            id=g.id, name=g.name, phone=g.phone, id_number=decrypt_field(g.id_number),
            vip_level=g.vip_level, notes=g.notes,
            stay_count=len(stays), total_spend=money(spend),
            last_stay=last.isoformat() if last else None,
        ))
    if q:
        kw = q.strip().lower()
        out = [x for x in out if kw in x.name.lower() or kw in x.phone.lower()
               or kw in x.id_number.lower()]
    if vip:
        out = [x for x in out if x.vip_level == vip]
    out.sort(key=lambda x: (-(x.stay_count), x.id))
    return out


@router.get("/{guest_id}", response_model=GuestDetail)
def guest_detail(guest_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    g = db.get(Guest, guest_id)
    if not g or (user.role != "platform_admin" and g.hotel_id != user.hotel_id):
        raise HTTPException(404, "客户不存在")
    stays = (db.query(Reservation)
             .filter(Reservation.guest_id == g.id,
                     Reservation.status.in_(["checked_in", "checked_out"]))
             .order_by(Reservation.check_in.desc()).all())
    rooms = {r.id: r.room_number for r in db.query(Room).filter(Room.hotel_id == g.hotel_id).all()}
    history = []
    spend = 0
    for r in stays:
        amount = money(((r.check_out - r.check_in).days) * r.rate)
        spend += amount
        room_no = rooms.get(r.room_id, "—") if r.room_id else "未分配"
        history.append({
            "reservation_id": r.id,
            "room_number": room_no,
            "check_in": r.check_in.isoformat(),
            "check_out": r.check_out.isoformat(),
            "status": r.status,
            "amount": amount,
        })
    return GuestDetail(
        id=g.id, name=g.name, phone=g.phone, id_number=decrypt_field(g.id_number),
        vip_level=g.vip_level, notes=g.notes,
        stay_count=len(stays), total_spend=money(spend),
        last_stay=history[0]["check_in"] if history else None,
        history=history,
    )


@router.post("")
def create_guest(body: GuestBody, hotel_id: int | None = None,
                 user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    hid = resolve_hotel_id(user, hotel_id)
    _dup_check(db, hid, phone=body.phone.strip(), id_number=body.id_number.strip())
    g = Guest(hotel_id=hid, name=body.name.strip(), phone=body.phone.strip(),
              id_number=encrypt_field(body.id_number.strip()), vip_level=body.vip_level, notes=body.notes)
    db.add(g)
    db.flush()
    log_op(db, hid, user, "guest_create", "guest", g.id, f"新增客户档案「{g.name}」")
    db.commit()
    return {"ok": True, "id": g.id}


@router.patch("/{guest_id}")
def update_guest(guest_id: int, body: GuestUpdateBody,
                 user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    g = db.get(Guest, guest_id)
    if not g or (user.role != "platform_admin" and g.hotel_id != user.hotel_id):
        raise HTTPException(404, "客户不存在")

    new_name = body.name.strip() if body.name is not None else None
    new_phone = body.phone.strip() if body.phone is not None else None
    new_id = body.id_number.strip() if body.id_number is not None else None
    plain_id = decrypt_field(g.id_number)  # 库内密文，比较/日志都用解密后的明文
    if new_name is not None and not new_name:
        raise HTTPException(400, "客人姓名不能为空")
    if (new_phone is not None and new_phone != g.phone) or \
            (new_id is not None and new_id != plain_id):
        _dup_check(db, g.hotel_id, phone=new_phone, id_number=new_id, exclude_id=g.id)

    changes: list[str] = []
    if new_name is not None and new_name != g.name:
        changes.append(f"姓名 {g.name}→{new_name}")
        g.name = new_name
    if new_phone is not None and new_phone != g.phone:
        changes.append(f"手机号 {g.phone or '未留'}→{new_phone or '未留'}")
        g.phone = new_phone
    if new_id is not None and new_id != plain_id:
        # 摘要落掩码：操作日志与库同泄露面，不落明文证件号
        changes.append(f"证件号 {mask_id_number(plain_id) or '未登记'}→{mask_id_number(new_id) or '未登记'}")
        g.id_number = encrypt_field(new_id)
    if body.notes is not None and body.notes.strip() != g.notes:
        changes.append(f"备注「{g.notes or '空'}」→「{body.notes.strip() or '空'}」")
        g.notes = body.notes.strip()

    if not changes:
        return {"ok": True}
    log_op(db, g.hotel_id, user, "guest_update", "guest", g.id,
           f"更新客户「{g.name}」：{' · '.join(changes)}")
    db.commit()
    return {"ok": True}
