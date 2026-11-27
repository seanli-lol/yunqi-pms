"""OTA 订单同步（美团插件调用）：按外部单号幂等建单 / 取消，排不下或需人工时写提醒。

口径（2026-11-25 与店主确认）：
- 渠道一推送新单就建 confirmed 预订；房价按结算价（整单合计 → 按间均摊 → 按晚/小时折单价）。
- 连住单建一笔多晚预订、整段锁同一间房；按房号顺序取能覆盖整段住期的空房（优先空净），
  同房型一间都排不下 → 不建单，写 no_room 提醒。多间单逐间排，排不下的间数单独提醒。
- 不走「连住自动并入」：OTA 单并进客人别的单后，渠道取消会连带取消别人的住期。
- 渠道取消：待确认/已确认 → 自动取消；已入住等 → 不动，写 cancel_manual 提醒。
- 已取消的间不会因渠道重复推送而复活（同 #间序号 存在即视为重复）。
- 渠道改签（2026-11-26）：原地改已登记的预订（住期 / 房型 / 间数 / 房费），原房在新住期还空着就不换房；
  改签生成新单号时预订改挂新单号，原单号随后的取消不再撤掉它。已入住 / 离店的间不自动改，
  新住期无房可换也不动原单，都写 modify_manual 提醒人工处理。
"""
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import (blocking_ids, can_access_hotel, fmt_money, free_rooms, get_current_user, log_op, money,
                      resolve_hotel_id)
from app.models import Channel, FolioItem, Guest, OtaAlert, Reservation, Room, RoomType, User
from app.routers.reservations import cancel_reservation, gen_code, res_out, room_charge_total_of, upsert_guest
from app.schemas import OtaAlertBody, OtaCancelBody, OtaGuestBody, OtaModifyBody, OtaOrderBody

router = APIRouter(prefix="/api/ota", tags=["ota"])

_STATUS_LABEL = {"checked_in": "在住", "checked_out": "已离店", "no_show": "未到店"}


def _channel(db: Session, hid: int, channel_id: int) -> Channel:
    ch = db.get(Channel, channel_id)
    if not ch or ch.hotel_id != hid:
        raise HTTPException(400, "来源渠道不存在")
    return ch


def _ref(raw: str) -> str:
    ref = (raw or "").strip()
    # 预留「#间序号」后缀的列宽（external_ref 列 64）
    if not ref or "#" in ref or len(ref) > 56:
        raise HTTPException(400, "外部订单号无效")
    return ref


def _stay_span(body: OtaOrderBody | OtaModifyBody):
    """校验住期 / 时长 / 结算价，返回 (入住, 离店, 计价单位数, 是否钟点)"""
    if not (1 <= body.room_count <= 20):
        raise HTTPException(400, "间数需在 1–20 之间")
    if body.settle_total < 0:
        raise HTTPException(400, "结算价不能为负数")
    if body.stay_type == "hourly":
        if not (1 <= body.hours <= 12):
            raise HTTPException(400, "钟点房时长需在 1–12 小时之间")
        # 钟点房占用整日，口径同 create_reservation
        return body.check_in, body.check_in + timedelta(days=1), body.hours, True
    if body.hours:
        raise HTTPException(400, "仅钟点房可指定入住时长")
    if body.check_out <= body.check_in:
        raise HTTPException(400, "离店日期必须晚于入住日期")
    return body.check_in, body.check_out, (body.check_out - body.check_in).days, False


def _room_index(r: Reservation) -> int:
    """external_ref「单号#间序号」里的间序号"""
    try:
        return int(r.external_ref.rsplit("#", 1)[1])
    except (AttributeError, IndexError, ValueError):
        return 1


def _pick(free: list[Room]) -> Room:
    """按房号顺序取一间，优先空净"""
    return sorted(free, key=lambda x: (x.status != "vacant_clean", x.room_number))[0]


def _set_room_charge(db: Session, r: Reservation, total: float, units: int, hourly: bool, user: User) -> None:
    """房费账目记结算价原值（不用 rate × 晚数反推，避免均摊后差一分）；多条房费行收拢为一条"""
    desc = (f"钟点房费 · {units} 小时 × ¥{fmt_money(r.rate)}" if hourly
            else f"房费 · {units} 晚 × ¥{fmt_money(r.rate)}")
    fees = (db.query(FolioItem)
            .filter(FolioItem.reservation_id == r.id, FolioItem.category == "room_charge")
            .order_by(FolioItem.id).all())
    if not fees:
        db.add(FolioItem(hotel_id=r.hotel_id, reservation_id=r.id, category="room_charge",
                         description=desc, amount=total, created_by=user.id))
        return
    fees[0].amount, fees[0].description = total, desc
    for x in fees[1:]:
        db.delete(x)


def _rows_of(db: Session, hid: int, channel_id: int, ref: str) -> list[Reservation]:
    return (db.query(Reservation)
            .filter(Reservation.hotel_id == hid, Reservation.channel_id == channel_id,
                    Reservation.external_ref.like(f"{ref}#%"))
            .order_by(Reservation.id).all())


def _raise_alert(db: Session, hid: int, ch: Channel, ref: str, kind: str, title: str, detail: str) -> OtaAlert:
    """同店同渠道同单号同类型的未处理提醒只留一条，重复上报时刷新内容"""
    a = (db.query(OtaAlert)
         .filter(OtaAlert.hotel_id == hid, OtaAlert.channel_id == ch.id, OtaAlert.external_ref == ref,
                 OtaAlert.kind == kind, OtaAlert.resolved_at.is_(None))
         .first())
    if a is None:
        a = OtaAlert(hotel_id=hid, channel_id=ch.id, external_ref=ref, kind=kind)
        db.add(a)
    a.title = title[:120]
    a.detail = detail[:500]
    db.flush()
    return a


def _alert_out(db: Session, a: OtaAlert) -> dict:
    ch = db.get(Channel, a.channel_id) if a.channel_id else None
    who = db.get(User, a.resolved_by) if a.resolved_by else None
    rows = _rows_of(db, a.hotel_id, a.channel_id, a.external_ref) if (a.external_ref and a.channel_id) else []
    return {
        "id": a.id, "kind": a.kind, "title": a.title, "detail": a.detail,
        "external_ref": a.external_ref, "channel_id": a.channel_id,
        "channel_name": ch.name if ch else None,
        "reservations": [{"id": r.id, "code": r.code, "status": r.status} for r in rows],
        "created_at": a.created_at, "resolved_at": a.resolved_at,
        "resolved_by_name": who.name if who else None,
    }


# ---------- 新订单 ----------
@router.post("/orders")
def sync_order(body: OtaOrderBody, hotel_id: int | None = None,
               user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    hid = resolve_hotel_id(db, user, hotel_id)
    ch = _channel(db, hid, body.channel_id)
    ref = _ref(body.external_ref)
    rt = db.get(RoomType, body.room_type_id)
    if not rt or rt.hotel_id != hid:
        raise HTTPException(400, "房型不存在")
    cin, cout, units, hourly = _stay_span(body)

    existing = {r.external_ref: r for r in _rows_of(db, hid, ch.id, ref)}
    # 按分均摊，余数分给前几间，保证各间房费之和 = 结算总价
    base_cents, rem = divmod(round(body.settle_total * 100), body.room_count)
    guest_name = body.guest_name.strip() or f"{ch.name}客人"
    remark = body.remark.strip()
    notes = (f"{ch.name}单号 {ref}" + (f" · {remark}" if remark else ""))[:200]

    guest = None
    created, duplicated, short = [], [], 0
    for i in range(1, body.room_count + 1):
        key = f"{ref}#{i}"
        if key in existing:
            duplicated.append(existing[key])
            continue
        free = free_rooms(db, hid, rt.id, cin, cout)
        if not free:
            short += 1
            continue
        room = _pick(free)
        if guest is None:
            guest = upsert_guest(db, hid, guest_name, body.guest_phone, "")
        room_total = money((base_cents + (1 if i <= rem else 0)) / 100)
        rate = money(room_total / units)
        r = Reservation(
            hotel_id=hid, code=gen_code(db, cin), guest_id=guest.id,
            room_type_id=rt.id, room_id=room.id, check_in=cin, check_out=cout,
            status="confirmed", channel_id=ch.id, rate=rate,
            stay_type=body.stay_type, hours=body.hours if hourly else 0,
            notes=notes, external_ref=key, created_by=user.id,
        )
        db.add(r)
        db.flush()
        _set_room_charge(db, r, room_total, units, hourly, user)
        log_op(db, hid, user, "reservation_create", "reservation", r.id,
               f"{ch.name}同步 · 创建预订 {r.code} · {guest.name} · {rt.name} · {room.room_number} 房 · "
               f"{cin:%m/%d}–{cout:%m/%d}{' · 钟点' if hourly else ''}")
        created.append(r)

    alert = None
    if short:
        alert = _raise_alert(
            db, hid, ch, ref, "no_room",
            f"{ch.name}订单无房可排：{rt.name} {cin:%m/%d}–{cout:%m/%d}",
            f"{ch.name}单号 {ref} · {guest_name} · 共 {body.room_count} 间，已排 {body.room_count - short} 间，"
            f"还差 {short} 间。同房型在该时段已无可排的房，请人工处理")
    db.commit()
    return {
        "created": [res_out(db, r) for r in created],
        "duplicated": [res_out(db, r) for r in duplicated],
        "short": short,
        "alert_id": alert.id if alert else None,
    }


# ---------- 渠道取消 ----------
@router.post("/orders/cancel")
def sync_cancel(body: OtaCancelBody, hotel_id: int | None = None,
                user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    hid = resolve_hotel_id(db, user, hotel_id)
    ch = _channel(db, hid, body.channel_id)
    ref = _ref(body.external_ref)
    rows = _rows_of(db, hid, ch.id, ref)
    if not rows:
        raise HTTPException(404, "未找到该外部订单")

    cancelled, already, manual = [], [], []
    for r in rows:
        if r.status == "cancelled":
            already.append(r.code)
        elif r.status in ("pending", "confirmed"):
            cancel_reservation(r.id, user, db)  # 复用前台取消口径（清收款 + 留痕），内部自行提交
            cancelled.append(r.code)
        else:
            manual.append(r)

    alert = None
    if manual:
        g = db.get(Guest, manual[0].guest_id)
        parts = []
        for r in manual:
            room = db.get(Room, r.room_id) if r.room_id else None
            parts.append(f"{r.code}（{room.room_number + ' 房 · ' if room else ''}{_STATUS_LABEL.get(r.status, r.status)}）")
        alert = _raise_alert(
            db, hid, ch, ref, "cancel_manual",
            f"{ch.name}已取消订单，客人已入住：{g.name if g else ''}",
            f"{ch.name}单号 {ref} · {'、'.join(parts)}。系统未自动处理，请核实后人工处理")
        db.commit()
    return {"cancelled": cancelled, "already": already,
            "manual": [r.code for r in manual], "alert_id": alert.id if alert else None}


# ---------- 渠道改签 ----------
@router.post("/orders/modify")
def sync_modify(body: OtaModifyBody, hotel_id: int | None = None,
                user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """改签：按间序号逐间对齐，原地改已登记的预订。

    待确认 / 已确认 → 改住期 / 房型 / 房费（原房在新住期还空着就不换房，否则换同房型空房）；
    已入住 / 离店、或新住期无房可换 → 不动，写 modify_manual 提醒；
    间数变多 → 补排新间；间数变少 → 取消多出的间。已取消的间不复活。"""
    hid = resolve_hotel_id(db, user, hotel_id)
    ch = _channel(db, hid, body.channel_id)
    ref = _ref(body.external_ref)
    new_ref = _ref(body.new_external_ref) if body.new_external_ref.strip() else ref
    rt = db.get(RoomType, body.room_type_id)
    if not rt or rt.hotel_id != hid:
        raise HTTPException(400, "房型不存在")
    cin, cout, units, hourly = _stay_span(body)
    rows = _rows_of(db, hid, ch.id, ref)
    if not any(r.status != "cancelled" for r in rows):
        raise HTTPException(404, "未找到该外部订单的有效预订")
    if new_ref != ref and _rows_of(db, hid, ch.id, new_ref):
        raise HTTPException(409, "改签后的新单号已登记过")

    by_idx = {_room_index(r): r for r in rows}
    guest = db.get(Guest, rows[0].guest_id)
    gname = guest.name if guest else ""
    base_cents, rem = divmod(round(body.settle_total * 100), body.room_count)
    span = f"{cin:%m/%d}–{cout:%m/%d}" + (f" · 钟点 {body.hours} 小时" if hourly else "")
    new_notes = rows[0].notes.replace(f"{ch.name}单号 {ref}", f"{ch.name}单号 {new_ref}")
    updated, unchanged, created, manual, manual_desc = [], [], [], [], []
    short = 0
    for i in range(1, body.room_count + 1):
        total = money((base_cents + (1 if i <= rem else 0)) / 100)
        rate = money(total / units)
        r = by_idx.get(i)
        if r is not None and r.status == "cancelled":
            continue
        if r is not None and r.status not in ("pending", "confirmed"):
            manual.append(r.code)
            manual_desc.append(f"{r.code}（{_STATUS_LABEL.get(r.status, r.status)}）")
            continue
        if r is None:
            free = free_rooms(db, hid, rt.id, cin, cout)
            if not free:
                short += 1
                continue
            room = _pick(free)
            r = Reservation(
                hotel_id=hid, code=gen_code(db, cin), guest_id=rows[0].guest_id,
                room_type_id=rt.id, room_id=room.id, check_in=cin, check_out=cout,
                status="confirmed", channel_id=ch.id, rate=rate,
                stay_type=body.stay_type, hours=body.hours if hourly else 0,
                notes=new_notes, external_ref=f"{new_ref}#{i}", created_by=user.id,
            )
            db.add(r)
            db.flush()
            _set_room_charge(db, r, total, units, hourly, user)
            log_op(db, hid, user, "reservation_create", "reservation", r.id,
                   f"{ch.name}改签 · 加订 {r.code} · {gname} · {rt.name} · {room.room_number} 房 · {span}")
            created.append(r.code)
            continue

        old_total = room_charge_total_of(db, r.id)
        if ((r.room_type_id, r.check_in, r.check_out, r.stay_type, r.hours)
                == (rt.id, cin, cout, body.stay_type, body.hours if hourly else 0)
                and abs(old_total - total) < 0.005):
            unchanged.append(r.code)
            continue
        old_room = db.get(Room, r.room_id) if r.room_id else None
        room = old_room
        if (room is None or room.room_type_id != rt.id or room.status == "maintenance"
                or blocking_ids(db, hid, room.id, cin, cout, exclude=r.id)):
            free = free_rooms(db, hid, rt.id, cin, cout, exclude_res_id=r.id)
            if not free:
                manual.append(r.code)
                manual_desc.append(f"{r.code}（新住期 {span} 同房型无房可换）")
                continue
            room = _pick(free)
        before = (f"{old_room.room_number + ' 房 · ' if old_room else ''}"
                  f"{r.check_in:%m/%d}–{r.check_out:%m/%d} · ¥{fmt_money(old_total)}")
        r.room_type_id, r.room_id, r.check_in, r.check_out = rt.id, room.id, cin, cout
        r.stay_type, r.hours, r.rate = body.stay_type, (body.hours if hourly else 0), rate
        _set_room_charge(db, r, total, units, hourly, user)
        log_op(db, hid, user, "reservation_move", "reservation", r.id,
               f"{ch.name}改签 · {r.code}（{gname}）：{before} → {room.room_number} 房 · {span} · ¥{fmt_money(total)}")
        updated.append(r.code)

    to_cancel = []
    for idx, r in sorted(by_idx.items()):
        if idx <= body.room_count or r.status == "cancelled":
            continue
        if r.status in ("pending", "confirmed"):
            to_cancel.append(r)
        else:
            manual.append(r.code)
            manual_desc.append(f"{r.code}（{_STATUS_LABEL.get(r.status, r.status)}，改签后间数减少）")

    # 改签生成了新单号：整单改挂新单号，原单号随后的取消推送就不会再撤掉这些预订
    if new_ref != ref:
        for r in rows:
            r.external_ref = f"{new_ref}#{_room_index(r)}"
            r.notes = r.notes.replace(f"{ch.name}单号 {ref}", f"{ch.name}单号 {new_ref}")

    alert = None
    if manual_desc or short:
        parts = manual_desc + ([f"还差 {short} 间无房可排"] if short else [])
        alert = _raise_alert(
            db, hid, ch, new_ref, "modify_manual",
            f"{ch.name}订单改签需人工处理：{gname}",
            f"{ch.name}单号 {new_ref}{f'（原单 {ref}）' if new_ref != ref else ''} 改为 {rt.name} × "
            f"{body.room_count} 间 · {span}：{'；'.join(parts)}。系统未自动处理，请核实后人工处理")
    db.commit()
    removed = []
    for r in to_cancel:
        cancel_reservation(r.id, user, db)  # 复用前台取消口径（清收款 + 留痕），内部自行提交
        removed.append(r.code)
    return {"updated": updated, "unchanged": unchanged, "created": created, "removed": removed,
            "manual": manual, "short": short, "alert_id": alert.id if alert else None, "guest_name": gname}


# ---------- 更正客人姓名 ----------
@router.post("/orders/guest")
def sync_guest_name(body: OtaGuestBody, hotel_id: int | None = None,
                    user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """渠道建单时只给了打码名（刘*）→ 读到全名后改挂到全名客户档案。

    只替换仍是打码名的预订（前台已手工改过名的不覆盖）；打码名档案可能被多笔订单共用
    （无手机号按姓名归档），所以不改档案本身，而是把本单改挂到全名档案。"""
    hid = resolve_hotel_id(db, user, hotel_id)
    ch = _channel(db, hid, body.channel_id)
    ref = _ref(body.external_ref)
    name = body.guest_name.strip()[:40]
    if not name or "*" in name:
        raise HTTPException(400, "客人姓名无效")
    rows = _rows_of(db, hid, ch.id, ref)
    if not rows:
        raise HTTPException(404, "未找到该外部订单")
    updated, skipped = [], []
    for r in rows:
        old = db.get(Guest, r.guest_id)
        if old is None or old.name == name:
            continue
        if "*" not in old.name:
            skipped.append(r.code)
            continue
        g = upsert_guest(db, hid, name, old.phone or "", "")
        r.guest_id = g.id
        log_op(db, hid, user, "reservation_edit", "reservation", r.id,
               f"{ch.name}同步 · 客人姓名 {old.name} → {name}（{r.code}）")
        updated.append(r.code)
    db.commit()
    return {"updated": updated, "skipped": skipped}


# ---------- 提醒 ----------
@router.get("/alerts")
def list_alerts(hotel_id: int | None = Query(default=None), include_resolved: bool = False,
                user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    hid = resolve_hotel_id(db, user, hotel_id)
    q = db.query(OtaAlert).filter(OtaAlert.hotel_id == hid)
    if not include_resolved:
        q = q.filter(OtaAlert.resolved_at.is_(None))
    return [_alert_out(db, a) for a in q.order_by(OtaAlert.id.desc()).limit(50).all()]


@router.post("/alerts")
def create_alert(body: OtaAlertBody, hotel_id: int | None = None,
                 user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    hid = resolve_hotel_id(db, user, hotel_id)
    ch = _channel(db, hid, body.channel_id)
    ref = (body.external_ref or "").strip()[:56]
    if not body.title.strip():
        raise HTTPException(400, "提醒标题不能为空")
    a = _raise_alert(db, hid, ch, ref, body.kind, body.title.strip(), body.detail.strip())
    db.commit()
    return _alert_out(db, a)


@router.post("/alerts/{alert_id}/resolve")
def resolve_alert(alert_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    a = db.get(OtaAlert, alert_id)
    if not a or not can_access_hotel(db, user, a.hotel_id):
        raise HTTPException(404, "提醒不存在")
    if a.resolved_at is None:
        a.resolved_at = datetime.now()
        a.resolved_by = user.id
        db.commit()
    return _alert_out(db, a)
