"""经营报表与仪表盘：自定义时间范围、趋势、单日明细（含操作人）"""
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func as sa_func
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_current_user, resolve_hotel_id
from app.models import (Channel, FolioItem, Guest, OperationLog,
                        Payment, Reservation, Room, RoomType)

router = APIRouter(prefix="/api", tags=["reports"])


def _range_params(from_date: str | None, to_date: str | None):
    today = date.today()
    to = date.fromisoformat(to_date) if to_date else today
    frm = date.fromisoformat(from_date) if from_date else to - timedelta(days=29)
    if frm > to:
        raise HTTPException(400, "开始日期不能晚于结束日期")
    return frm, to


def _sold_nights(db: Session, hotel_id: int, frm: date, to: date) -> int:
    """统计范围内被占用的间夜数（checked_in / checked_out）"""
    res = db.query(Reservation).filter(
        Reservation.hotel_id == hotel_id,
        Reservation.status.in_(["checked_in", "checked_out"]),
        Reservation.check_in < to,
        Reservation.check_out > frm,
    ).all()
    nights = 0
    for r in res:
        s = max(r.check_in, frm)
        e = min(r.check_out, to)
        if e > s:
            nights += (e - s).days
    return nights


def _charges(db: Session, hotel_id: int, frm: date, to: date):
    """按日统计账目（房费 / 其他），按账目创建日期归属"""
    rows = (db.query(FolioItem)
            .filter(FolioItem.hotel_id == hotel_id,
                    sa_func.date(FolioItem.created_at) >= frm.isoformat(),
                    sa_func.date(FolioItem.created_at) <= to.isoformat())
            .all())
    per_day: dict[str, dict] = {}
    room_total = other_total = 0
    for x in rows:
        d = x.created_at.date().isoformat()
        slot = per_day.setdefault(d, {"revenue": 0, "room": 0, "other": 0})
        if x.category == "room_charge":
            slot["room"] += x.amount
            room_total += x.amount
        else:
            slot["other"] += x.amount
            other_total += x.amount
        slot["revenue"] += x.amount
    return per_day, room_total, other_total


@router.get("/reports/summary")
def reports_summary(from_date: str | None = None, to_date: str | None = None,
                    hotel_id: int | None = None,
                    user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    hid = resolve_hotel_id(user, hotel_id)
    frm, to = _range_params(from_date, to_date)
    days = (to - frm).days + 1
    total_rooms = db.query(Room).filter(Room.hotel_id == hid).count()
    available = total_rooms * days
    sold = _sold_nights(db, hid, frm, to + timedelta(days=1))
    per_day, room_total, other_total = _charges(db, hid, frm, to)
    occupancy = round(sold / available * 100, 1) if available else 0
    adr = round(room_total / sold) if sold else 0
    revpar = round(room_total / available) if available else 0
    return {
        "occupancy": occupancy, "adr": adr, "revpar": revpar,
        "revenue_total": room_total + other_total,
        "revenue_room": room_total, "revenue_other": other_total,
        "days": days, "rooms": total_rooms,
    }


@router.get("/reports/trends")
def reports_trends(from_date: str | None = None, to_date: str | None = None,
                   hotel_id: int | None = None,
                   user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    hid = resolve_hotel_id(user, hotel_id)
    frm, to = _range_params(from_date, to_date)
    total_rooms = db.query(Room).filter(Room.hotel_id == hid).count()
    per_day, _, _ = _charges(db, hid, frm, to)
    res = db.query(Reservation).filter(
        Reservation.hotel_id == hid,
        Reservation.status.in_(["checked_in", "checked_out"]),
        Reservation.check_in < to + timedelta(days=1),
        Reservation.check_out > frm,
    ).all()
    occ_by_day = {frm + timedelta(days=i): 0 for i in range((to - frm).days + 1)}
    for r in res:
        s = max(r.check_in, frm)
        e = min(r.check_out - timedelta(days=1), to)
        while s <= e:
            occ_by_day[s] = occ_by_day.get(s, 0) + 1
            s += timedelta(days=1)
    out = []
    for d in sorted(occ_by_day):
        ds = d.isoformat()
        out.append({
            "date": ds,
            "occupancy": round(occ_by_day[d] / total_rooms * 100, 1) if total_rooms else 0,
            "revenue": per_day.get(ds, {}).get("revenue", 0),
            "revenue_room": per_day.get(ds, {}).get("room", 0),
            "revenue_other": per_day.get(ds, {}).get("other", 0),
        })
    return out


@router.get("/reports/room-types")
def reports_room_types(from_date: str | None = None, to_date: str | None = None,
                       hotel_id: int | None = None,
                       user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    hid = resolve_hotel_id(user, hotel_id)
    frm, to = _range_params(from_date, to_date)
    types = db.query(RoomType).filter(RoomType.hotel_id == hid).all()
    out = []
    for t in types:
        rooms = db.query(Room).filter(Room.room_type_id == t.id).count()
        res = db.query(Reservation).filter(
            Reservation.hotel_id == hid,
            Reservation.room_type_id == t.id,
            Reservation.status.in_(["checked_in", "checked_out"]),
            Reservation.check_in < to + timedelta(days=1),
            Reservation.check_out > frm,
        ).all()
        sold = 0
        revenue = 0
        for r in res:
            s = max(r.check_in, frm)
            e = min(r.check_out, to + timedelta(days=1))
            if e > s:
                sold += (e - s).days
            revenue += (r.check_out - r.check_in).days * r.rate
        available = rooms * ((to - frm).days + 1)
        out.append({
            "room_type_id": t.id, "name": t.name, "rooms": rooms,
            "occupancy": round(sold / available * 100, 1) if available else 0,
            "adr": round(revenue / sold) if sold else 0,
            "revenue": revenue,
        })
    return out


@router.get("/reports/day")
def reports_day(day: str, hotel_id: int | None = None,
                user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    hid = resolve_hotel_id(user, hotel_id)
    try:
        d = date.fromisoformat(day)
    except ValueError:
        raise HTTPException(400, "日期格式应为 YYYY-MM-DD")
    total_rooms = db.query(Room).filter(Room.hotel_id == hid).count()
    res = db.query(Reservation).filter(
        Reservation.hotel_id == hid,
        Reservation.status.in_(["checked_in", "checked_out"]),
        Reservation.check_in <= d,
        Reservation.check_out > d,
    ).all()
    occupancy = round(len(res) / total_rooms * 100, 1) if total_rooms else 0
    per_day, _, _ = _charges(db, hid, d, d)
    day_slot = per_day.get(d.isoformat(), {"revenue": 0, "room": 0, "other": 0})
    arrivals = db.query(Reservation).filter(
        Reservation.hotel_id == hid, Reservation.check_in == d,
        Reservation.status.in_(["checked_in", "checked_out", "confirmed", "pending"])).count()
    departures = db.query(Reservation).filter(
        Reservation.hotel_id == hid, Reservation.check_out == d,
        Reservation.status.in_(["checked_in", "checked_out"])).count()
    ops = (db.query(OperationLog)
           .filter(OperationLog.hotel_id == hid,
                   sa_func.date(OperationLog.created_at) == d.isoformat())
           .order_by(OperationLog.created_at).all())
    operations = [{
        "time": o.created_at.strftime("%H:%M"),
        "action": o.action,
        "target": (o.object_type or ""),
        "summary": o.summary,
        "operator": o.operator_name or "系统",
    } for o in ops]
    return {
        "date": d.isoformat(),
        "occupancy": occupancy,
        "revenue": day_slot["revenue"],
        "revenue_room": day_slot["room"],
        "revenue_other": day_slot["other"],
        "arrivals": arrivals,
        "departures": departures,
        "operations": operations,
    }


@router.get("/dashboard")
def dashboard(hotel_id: int | None = None,
              user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    hid = resolve_hotel_id(user, hotel_id)
    today = date.today()
    rooms = db.query(Room).filter(Room.hotel_id == hid).all()
    total = len(rooms)
    occupied = len([r for r in rooms if r.status == "occupied"])
    maintenance = len([r for r in rooms if r.status == "maintenance"])

    arrivals = db.query(Reservation).filter(
        Reservation.hotel_id == hid, Reservation.check_in == today,
        Reservation.status.in_(["pending", "confirmed"])).all()
    departures = db.query(Reservation).filter(
        Reservation.hotel_id == hid, Reservation.check_out == today,
        Reservation.status == "checked_in").all()
    pending_count = db.query(Reservation).filter(
        Reservation.hotel_id == hid, Reservation.status == "pending").count()

    # 今日营收（按账目创建日期）
    per_day, room_rev, other_rev = _charges(db, hid, today, today)
    today_slot = per_day.get(today.isoformat(), {"revenue": 0})
    revenue_today = today_slot.get("revenue", 0)

    # 未结清账单（在住 + 已离店，余额 > 0）
    unpaid_res = db.query(Reservation).filter(
        Reservation.hotel_id == hid,
        Reservation.status.in_(["checked_in", "checked_out"])).all()
    from app.deps import balance_of
    unpaid = []
    for r in unpaid_res:
        bal = balance_of(db, r.id)
        if bal > 0:
            unpaid.append({"reservation_id": r.id, "balance": bal})
    unpaid_amount = sum(x["balance"] for x in unpaid)

    # 抵店列表（前 4 条）与离店列表（前 3 条）
    guests = {g.id: g for g in db.query(Guest).filter(Guest.hotel_id == hid).all()}
    rooms_map = {r.id: r for r in rooms}
    types_map = {t.id: t for t in db.query(RoomType).filter(RoomType.hotel_id == hid).all()}
    channels = {c.id: c for c in db.query(Channel).filter(Channel.hotel_id == hid).all()}
    from app.deps import balance_of as _bal

    def res_brief(r: Reservation):
        g = guests.get(r.guest_id)
        room = rooms_map.get(r.room_id) if r.room_id else None
        ch = channels.get(r.channel_id) if r.channel_id else None
        return {
            "id": r.id, "code": r.code,
            "guest_name": g.name if g else "",
            "vip_level": g.vip_level if g else "",
            "room_number": room.room_number if room else None,
            "room_type_name": (types_map.get(r.room_type_id).name if types_map.get(r.room_type_id) else ""),
            "check_in": r.check_in.isoformat(),
            "check_out": r.check_out.isoformat(),
            "nights": (r.check_out - r.check_in).days,
            "rate": r.rate,
            "status": r.status,
            "channel_name": ch.name if ch else "",
            "balance_due": max(0, _bal(db, r.id)),
        }

    arrival_items = [res_brief(r) for r in arrivals[:4]]
    departure_list = departures
    departure_items = []
    for r in departure_list[:3]:
        b = res_brief(r)
        b["balance_due"] = max(0, _bal(db, r.id))
        departure_items.append(b)

    return {
        "occupancy_today": round(occupied / total * 100) if total else 0,
        "occupied": occupied, "total_rooms": total,
        "arrivals": len(arrivals), "arrivals_ready": len(arrivals),
        "departures": len(departures),
        "unpaid_count": len(unpaid), "unpaid_amount": unpaid_amount,
        "pending_confirm": pending_count,
        "maintenance_count": maintenance,
        "revenue_today": revenue_today,
        "revenue_room": room_rev,
        "revenue_other": other_rev,
        "arrival_items": arrival_items,
        "departure_items": departure_items,
        "unpaid_items": [
            {**res_brief(next(r for r in unpaid_res if r.id == x["reservation_id"]))}
            for x in unpaid[:3]
        ],
        "today_label": f"{today.month}月{today.day}日",
    }
