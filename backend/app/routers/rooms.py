"""房型 / 客房管理 + 房态盘（日历与单日网格共用的聚合接口）"""
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import (dates_overlap, free_rooms, get_current_user, log_op,
                      resolve_hotel_id)
from app.models import Channel, Guest, Hotel, Reservation, Room, RoomType
from app.schemas import RoomBody, RoomOut, RoomPatch, RoomTypeBody, RoomTypeOut

router = APIRouter(prefix="/api", tags=["rooms"])


# ---------- 房型 ----------
@router.get("/room-types", response_model=list[RoomTypeOut])
def list_room_types(hotel_id: int | None = None, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    hid = resolve_hotel_id(user, hotel_id)
    types = db.query(RoomType).filter(RoomType.hotel_id == hid).order_by(RoomType.id).all()
    return [RoomTypeOut(
        id=t.id, name=t.name, base_price=t.base_price, hourly_price=t.hourly_price,
        capacity=t.capacity, description=t.description,
        room_count=db.query(Room).filter(Room.room_type_id == t.id).count(),
    ) for t in types]


@router.post("/room-types", response_model=RoomTypeOut)
def create_room_type(body: RoomTypeBody, hotel_id: int | None = None,
                     user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    hid = resolve_hotel_id(user, hotel_id)
    t = RoomType(hotel_id=hid, name=body.name.strip(), base_price=body.base_price,
                 hourly_price=body.hourly_price, capacity=body.capacity, description=body.description)
    db.add(t)
    db.flush()
    price_tag = f" · 钟点 ¥{t.hourly_price}/小时" if t.hourly_price else ""
    log_op(db, hid, user, "room_type_create", "room_type", t.id,
           f"新增房型「{t.name}」¥{t.base_price}/晚{price_tag}")
    db.commit()
    return RoomTypeOut(id=t.id, name=t.name, base_price=t.base_price,
                       hourly_price=t.hourly_price, capacity=t.capacity,
                       description=t.description, room_count=0)


@router.patch("/room-types/{type_id}", response_model=RoomTypeOut)
def patch_room_type(type_id: int, body: RoomTypeBody,
                    user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    t = db.get(RoomType, type_id)
    if not t or (user.role != "platform_admin" and t.hotel_id != user.hotel_id):
        raise HTTPException(404, "房型不存在")
    t.name, t.base_price, t.hourly_price, t.capacity, t.description = (
        body.name.strip(), body.base_price, body.hourly_price, body.capacity, body.description)
    log_op(db, t.hotel_id, user, "room_type_update", "room_type", t.id, f"更新房型「{t.name}」")
    db.commit()
    return RoomTypeOut(id=t.id, name=t.name, base_price=t.base_price,
                       hourly_price=t.hourly_price, capacity=t.capacity,
                       description=t.description,
                       room_count=db.query(Room).filter(Room.room_type_id == t.id).count())


@router.delete("/room-types/{type_id}")
def delete_room_type(type_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    t = db.get(RoomType, type_id)
    if not t or (user.role != "platform_admin" and t.hotel_id != user.hotel_id):
        raise HTTPException(404, "房型不存在")
    if db.query(Room).filter(Room.room_type_id == type_id).count():
        raise HTTPException(400, "该房型下仍有客房，不可删除")
    db.delete(t)
    db.commit()
    return {"ok": True}


# ---------- 客房 ----------
@router.get("/rooms", response_model=list[RoomOut])
def list_rooms(hotel_id: int | None = None, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    hid = resolve_hotel_id(user, hotel_id)
    rooms = (db.query(Room, RoomType)
             .join(RoomType, Room.room_type_id == RoomType.id)
             .filter(Room.hotel_id == hid)
             .order_by(Room.room_number).all())
    return [RoomOut(
        id=r.id, room_number=r.room_number, floor=r.floor, status=r.status,
        notes=r.notes, room_type_id=t.id, room_type_name=t.name, base_price=t.base_price,
    ) for r, t in rooms]


@router.post("/rooms", response_model=RoomOut)
def create_room(body: RoomBody, hotel_id: int | None = None,
                user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    hid = resolve_hotel_id(user, hotel_id)
    t = db.get(RoomType, body.room_type_id)
    if not t or t.hotel_id != hid:
        raise HTTPException(400, "房型不存在")
    if db.query(Room).filter(Room.hotel_id == hid, Room.room_number == body.room_number.strip()).first():
        raise HTTPException(400, "房号已存在")
    r = Room(hotel_id=hid, room_type_id=t.id, room_number=body.room_number.strip(),
             floor=body.floor, notes=body.notes, status="vacant_clean")
    db.add(r)
    db.flush()
    log_op(db, hid, user, "room_create", "room", r.id, f"新增客房 {r.room_number}（{t.name}）")
    db.commit()
    return RoomOut(id=r.id, room_number=r.room_number, floor=r.floor, status=r.status,
                   notes=r.notes, room_type_id=t.id, room_type_name=t.name, base_price=t.base_price)


@router.patch("/rooms/{room_id}", response_model=RoomOut)
def patch_room(room_id: int, body: RoomPatch, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Room, room_id)
    if not r or (user.role != "platform_admin" and r.hotel_id != user.hotel_id):
        raise HTTPException(404, "客房不存在")
    # 局部更新口径：null = 不改；纯房态切换沿用 room_status 日志（操作列下拉），客房信息编辑记 room_update
    changed = []
    info_changed = False
    status_labels = {"vacant_clean": "空净", "vacant_dirty": "空脏", "maintenance": "维修"}
    if body.status and body.status != r.status:
        if body.status == "occupied":
            raise HTTPException(400, "不能直接设为在住，请通过办理入住流程")
        if r.status == "occupied":
            raise HTTPException(400, "该房有在住客人，请先办理退房再调整房态")
        r.status = body.status
        changed.append(f"房态→{status_labels.get(body.status, body.status)}")
    if body.room_number is not None:
        new_no = body.room_number.strip()
        if not new_no:
            raise HTTPException(400, "房号不能为空")
        if new_no != r.room_number:
            if db.query(Room).filter(Room.hotel_id == r.hotel_id, Room.room_number == new_no,
                                     Room.id != r.id).first():
                raise HTTPException(400, "房号已存在")
            changed.append(f"房号 {r.room_number}→{new_no}")
            r.room_number = new_no
            info_changed = True
    if body.floor is not None and body.floor != r.floor:
        changed.append(f"楼层 {r.floor}→{body.floor}")
        r.floor = body.floor
        info_changed = True
    if body.room_type_id is not None and body.room_type_id != r.room_type_id:
        t = db.get(RoomType, body.room_type_id)
        if not t or t.hotel_id != r.hotel_id:
            raise HTTPException(400, "房型不存在")
        cur = db.get(RoomType, r.room_type_id)
        changed.append(f"房型 {cur.name}→{t.name}")
        r.room_type_id = t.id
        info_changed = True
    if body.notes is not None and body.notes != r.notes:
        r.notes = body.notes
        changed.append("更新备注")
        info_changed = True
    if not changed:  # 无实际变化不打日志
        t = db.get(RoomType, r.room_type_id)
        return RoomOut(id=r.id, room_number=r.room_number, floor=r.floor, status=r.status,
                       notes=r.notes, room_type_id=t.id, room_type_name=t.name, base_price=t.base_price)
    log_op(db, r.hotel_id, user, "room_update" if info_changed else "room_status", "room", r.id,
           f"客房 {r.room_number} {' · '.join(changed)}")
    db.commit()
    t = db.get(RoomType, r.room_type_id)
    return RoomOut(id=r.id, room_number=r.room_number, floor=r.floor, status=r.status,
                   notes=r.notes, room_type_id=t.id, room_type_name=t.name, base_price=t.base_price)


@router.delete("/rooms/{room_id}")
def delete_room(room_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.get(Room, room_id)
    if not r or (user.role != "platform_admin" and r.hotel_id != user.hotel_id):
        raise HTTPException(404, "客房不存在")
    if db.query(Reservation).filter(Reservation.room_id == room_id).count():
        raise HTTPException(400, "该客房有历史预订，不可删除")
    db.delete(r)
    db.commit()
    return {"ok": True}


# ---------- 可售房查询（入住向导选房） ----------
@router.get("/rooms/available")
def available_rooms(room_type_id: int, check_in: str, check_out: str,
                    exclude_res_id: int | None = None,
                    include_dirty: int | None = None,
                    allow_prev_guest: int | None = None,
                    hotel_id: int | None = None,
                    user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    hid = resolve_hotel_id(user, hotel_id)
    cin = date.fromisoformat(check_in)
    cout = date.fromisoformat(check_out)
    if cout <= cin:
        raise HTTPException(400, "离店日期必须晚于入住日期")
    # include_dirty / allow_prev_guest：入住放宽——空脏房、前客未退（在住）也可入选
    # exclude_res_id：办理入住时排除本预订自身，避免预订已锁定的房被自己挡住
    free = free_rooms(db, hid, room_type_id, cin, cout,
                      exclude_res_id=exclude_res_id,
                      only_clean=not include_dirty,
                      include_checked_in=not allow_prev_guest)
    return [{"id": r.id, "room_number": r.room_number, "floor": r.floor,
             "status": r.status} for r in free]


# ---------- 房态盘（日历 / 单日网格共用） ----------
WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"]


@router.get("/rooms/board")
def rooms_board(
    start: str | None = None,
    days: int = 14,
    hotel_id: int | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    hid = resolve_hotel_id(user, hotel_id)
    days = max(1, min(60, days))
    start_d = date.fromisoformat(start) if start else date.today() - timedelta(days=2)
    end_d = start_d + timedelta(days=days)

    types = db.query(RoomType).filter(RoomType.hotel_id == hid).order_by(RoomType.id).all()
    rooms = db.query(Room).filter(Room.hotel_id == hid).order_by(Room.room_number).all()
    # 覆盖窗口的预订（已锁定房号的）
    res_list = (db.query(Reservation)
                .filter(Reservation.hotel_id == hid,
                        Reservation.room_id.isnot(None),
                        Reservation.check_in < end_d,
                        Reservation.check_out > start_d,
                        Reservation.status.in_(["pending", "confirmed", "checked_in", "checked_out"]))
                .all())
    channels = {c.id: c for c in db.query(Channel).filter(Channel.hotel_id == hid).all()}
    guests = {g.id: g for g in db.query(Guest).filter(Guest.hotel_id == hid).all()}

    def totals(res_id: int) -> tuple[int, int]:
        from app.deps import folio_totals
        return folio_totals(db, res_id)

    blocks_by_room: dict[int, list[dict]] = {}
    occupied_by_day: list[set[int]] = [set() for _ in range(days)]
    for res in res_list:
        g = guests.get(res.guest_id)
        ch = channels.get(res.channel_id) if res.channel_id else None
        ci, co = res.check_in, res.check_out
        col_start = (ci - start_d).days
        col_end = (co - start_d).days
        if col_start < 0:
            col_start = 0
        if col_end > days:
            col_end = days
        span = col_end - col_start
        if span <= 0:
            continue
        items_total, paid_total = totals(res.id)
        block = {
            "id": res.id,
            "code": res.code,
            "guest_name": g.name if g else "",
            "channel_id": res.channel_id,
            "channel_name": ch.name if ch else "",
            "channel_color": ch.color if ch else "#86868B",
            "check_in": ci.isoformat(),
            "check_out": co.isoformat(),
            "status": res.status,
            "rate": res.rate,
            "stay_type": res.stay_type,
            "hours": res.hours,
            "items_total": items_total,
            "paid_total": paid_total,
            "balance_due": max(0, items_total - paid_total),
            "col_start": col_start,
            "nights": span,
            # 提前退房截断标记（False = 正常占满原订区间）
            "truncated": False,
        }
        blocks_by_room.setdefault(res.room_id, []).append(block)
        # 提前退房截断：灰块止于实际离店日（该日只压左 1/3，表示白天仍占房、下午腾空）。
        # 原「可售」虚纹已退役——截断后右侧空白即可售；当日入住当日退的窄存根
        # （stub_nights==1，钟点房/当日往返）由前端聚合为格角「退房」角标，不限笔数
        if res.status == "checked_out" and res.actual_check_out and res.actual_check_out < co:
            actual = res.actual_check_out
            # 灰块存根跨度：入住日 ~ 实际离店日（含，按窗口裁剪）；离店日在窗口之前则无存根
            stub_end = min(days, (actual - start_d).days + 1)
            stub_span = stub_end - col_start
            if stub_span <= 0:
                # 存根整段在窗口前（离店日早于窗口起点）：无可视部分，nights 归零让前端跳过渲染
                block["truncated"] = True
                block["nights"] = 0
            else:
                block["truncated"] = True
                block["stub_nights"] = stub_span
                # 存根末日 = 实际离店日本身 → 灰块右侧收进 1/3（视觉上该日只压左侧）
                block["stub_cut"] = (actual - start_d).days < days
        # 占用统计（在住/已确认才算占房）
        if res.status in ("confirmed", "checked_in"):
            for d in range(max(0, (ci - start_d).days), min(days, (co - start_d).days)):
                occupied_by_day[d].add(res.room_id)

    room_meta = {r.id: r for r in rooms}
    groups = []
    for t in types:
        t_rooms = [r for r in rooms if r.room_type_id == t.id]
        if not t_rooms:
            continue
        rooms_out = []
        for r in t_rooms:
            current = None
            if r.status == "occupied":
                cur = (db.query(Reservation)
                       .filter(Reservation.room_id == r.id, Reservation.status == "checked_in")
                       .order_by(Reservation.check_out.desc()).first())
                if cur:
                    g = guests.get(cur.guest_id)
                    current = {
                        "guest_name": g.name if g else "",
                        "check_out": cur.check_out.isoformat(),
                        "code": cur.code,
                    }
            rooms_out.append({
                "id": r.id,
                "number": r.room_number,
                "floor": r.floor,
                "status": r.status,
                "notes": r.notes,
                "room_type_name": t.name,
                "base_price": t.base_price,
                "hourly_price": t.hourly_price,
                "current_guest": current["guest_name"] if current else None,
                "current_check_out": current["check_out"] if current else None,
                "current_code": current["code"] if current else None,
                "blocks": blocks_by_room.get(r.id, []),
            })
        groups.append({"room_type_id": t.id, "name": t.name, "rooms": rooms_out})

    # 维修房计入占用（不可售）
    maint_ids = {r.id for r in rooms if r.status == "maintenance"}
    remain = []
    for d in range(days):
        day_d = start_d + timedelta(days=d)
        blocked = occupied_by_day[d] | maint_ids
        remain.append(len([r for r in rooms if r.id not in blocked]))

    day_list = []
    for d in range(days):
        dd = start_d + timedelta(days=d)
        day_list.append({
            "date": dd.isoformat(),
            "weekday": WEEKDAYS[dd.weekday()],
            "is_today": dd == date.today(),
        })

    return {
        "start": start_d.isoformat(),
        "days": days,
        "day_list": day_list,
        "remain": remain,
        "groups": groups,
    }
