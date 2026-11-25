"""OTA 订单同步（美团插件调用）：按外部单号幂等建单 / 取消，排不下或需人工时写提醒。

口径（2026-11-25 与店主确认）：
- 渠道一推送新单就建 confirmed 预订；房价按结算价（整单合计 → 按间均摊 → 按晚/小时折单价）。
- 连住单建一笔多晚预订、整段锁同一间房；按房号顺序取能覆盖整段住期的空房（优先空净），
  同房型一间都排不下 → 不建单，写 no_room 提醒。多间单逐间排，排不下的间数单独提醒。
- 不走「连住自动并入」：OTA 单并进客人别的单后，渠道取消会连带取消别人的住期。
- 渠道取消：待确认/已确认 → 自动取消；已入住等 → 不动，写 cancel_manual 提醒。
- 已取消的间不会因渠道重复推送而复活（同 #间序号 存在即视为重复）。
"""
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import can_access_hotel, fmt_money, free_rooms, get_current_user, log_op, money, resolve_hotel_id
from app.models import Channel, FolioItem, Guest, OtaAlert, Reservation, Room, RoomType, User
from app.routers.reservations import cancel_reservation, gen_code, res_out, upsert_guest
from app.schemas import OtaAlertBody, OtaCancelBody, OtaGuestBody, OtaOrderBody

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
    if not (1 <= body.room_count <= 20):
        raise HTTPException(400, "间数需在 1–20 之间")
    if body.settle_total < 0:
        raise HTTPException(400, "结算价不能为负数")

    hourly = body.stay_type == "hourly"
    if hourly:
        if not (1 <= body.hours <= 12):
            raise HTTPException(400, "钟点房时长需在 1–12 小时之间")
        cin = body.check_in
        cout = cin + timedelta(days=1)  # 钟点房占用整日，口径同 create_reservation
        units = body.hours
    else:
        if body.hours:
            raise HTTPException(400, "仅钟点房可指定入住时长")
        if body.check_out <= body.check_in:
            raise HTTPException(400, "离店日期必须晚于入住日期")
        cin, cout = body.check_in, body.check_out
        units = (cout - cin).days

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
        room = sorted(free, key=lambda x: (x.status != "vacant_clean", x.room_number))[0]
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
        desc = (f"钟点房费 · {units} 小时 × ¥{fmt_money(rate)}" if hourly
                else f"房费 · {units} 晚 × ¥{fmt_money(rate)}")
        # 账目记结算价原值（不用 rate × 晚数反推，避免均摊后差一分）
        db.add(FolioItem(hotel_id=hid, reservation_id=r.id, category="room_charge",
                         description=desc, amount=room_total, created_by=user.id))
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
