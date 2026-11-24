"""预订来源渠道：颜色与展示顺序可配置"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import can_access_hotel, get_current_user, log_op, resolve_hotel_id
from app.models import Channel, Reservation, User
from app.schemas import ChannelBody, ChannelOut, ChannelPatch

router = APIRouter(prefix="/api/channels", tags=["channels"])


@router.get("", response_model=list[ChannelOut])
def list_channels(
    hotel_id: int | None = None,
    include_inactive: bool = False,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    hid = resolve_hotel_id(db, user, hotel_id)
    q = db.query(Channel).filter(Channel.hotel_id == hid)
    if not include_inactive:
        q = q.filter(Channel.is_active)
    return q.order_by(Channel.sort_order, Channel.id).all()


@router.post("", response_model=ChannelOut)
def create_channel(body: ChannelBody, hotel_id: int | None = None,
                   user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    hid = resolve_hotel_id(db, user, hotel_id)
    sort = body.sort_order
    if sort is None:
        mx = db.query(Channel).filter(Channel.hotel_id == hid).count()
        sort = mx + 1
    c = Channel(hotel_id=hid, name=body.name.strip(), color=body.color, sort_order=sort)
    db.add(c)
    db.flush()
    log_op(db, hid, user, "channel_create", "channel", c.id, f"新增预订渠道「{c.name}」颜色 {c.color}")
    db.commit()
    return ChannelOut(id=c.id, name=c.name, color=c.color, sort_order=c.sort_order, is_active=c.is_active)


@router.patch("/{channel_id}", response_model=ChannelOut)
def patch_channel(channel_id: int, body: ChannelPatch,
                  user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    c = db.get(Channel, channel_id)
    if not c or (not can_access_hotel(db, user, c.hotel_id)):
        raise HTTPException(404, "渠道不存在")
    if body.name is not None:
        c.name = body.name.strip()
    if body.color is not None:
        c.color = body.color
    if body.sort_order is not None:
        c.sort_order = body.sort_order
    if body.is_active is not None:
        c.is_active = body.is_active
    log_op(db, c.hotel_id, user, "channel_update", "channel", c.id, f"更新预订渠道「{c.name}」")
    db.commit()
    return ChannelOut(id=c.id, name=c.name, color=c.color, sort_order=c.sort_order, is_active=c.is_active)


@router.delete("/{channel_id}")
def delete_channel(channel_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """有历史订单的渠道不可物理删除：改为停用"""
    c = db.get(Channel, channel_id)
    if not c or (not can_access_hotel(db, user, c.hotel_id)):
        raise HTTPException(404, "渠道不存在")
    # 判定依据：该渠道名下（同店）是否有历史预订
    used = db.query(Reservation).filter(
        Reservation.hotel_id == c.hotel_id,
        Reservation.channel_id == channel_id,
    ).count()
    if used:
        c.is_active = False
        log_op(db, c.hotel_id, user, "channel_disable", "channel", c.id, f"停用渠道「{c.name}」（有 {used} 条历史预订）")
        db.commit()
        return {"ok": True, "disabled": True}
    log_op(db, c.hotel_id, user, "channel_delete", "channel", c.id, f"删除渠道「{c.name}」")
    db.delete(c)
    db.commit()
    return {"ok": True, "disabled": False}
