"""客户档案"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_current_user, log_op, resolve_hotel_id
from app.models import Guest, Reservation, Room, User
from app.schemas import GuestBody, GuestDetail, GuestNotesBody, GuestOut

router = APIRouter(prefix="/api/guests", tags=["guests"])


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
            id=g.id, name=g.name, phone=g.phone, id_number=g.id_number,
            vip_level=g.vip_level, notes=g.notes,
            stay_count=len(stays), total_spend=spend,
            last_stay=last.isoformat() if last else None,
        ))
    if q:
        kw = q.strip().lower()
        out = [x for x in out if kw in x.name.lower() or kw in x.phone.lower()]
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
        amount = ((r.check_out - r.check_in).days) * r.rate
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
        id=g.id, name=g.name, phone=g.phone, id_number=g.id_number,
        vip_level=g.vip_level, notes=g.notes,
        stay_count=len(stays), total_spend=spend,
        last_stay=history[0]["check_in"] if history else None,
        history=history,
    )


@router.post("")
def create_guest(body: GuestBody, hotel_id: int | None = None,
                 user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    hid = resolve_hotel_id(user, hotel_id)
    g = Guest(hotel_id=hid, name=body.name.strip(), phone=body.phone.strip(),
              id_number=body.id_number.strip(), vip_level=body.vip_level, notes=body.notes)
    db.add(g)
    db.flush()
    log_op(db, hid, user, "guest_create", "guest", g.id, f"新增客户档案「{g.name}」")
    db.commit()
    return {"ok": True, "id": g.id}


@router.patch("/{guest_id}")
def update_guest_notes(guest_id: int, body: GuestNotesBody,
                       user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    g = db.get(Guest, guest_id)
    if not g or (user.role != "platform_admin" and g.hotel_id != user.hotel_id):
        raise HTTPException(404, "客户不存在")
    g.notes = body.notes.strip()
    log_op(db, g.hotel_id, user, "guest_update", "guest", g.id, f"更新客户「{g.name}」备注")
    db.commit()
    return {"ok": True}
