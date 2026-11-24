"""酒店与员工管理：多店隔离的入口"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.config import ROLE_LABELS
from app.db import get_db
from app.deps import can_access_hotel, get_current_user, log_op, require_platform_admin
from app.models import Hotel, Room, User, UserHotel
from app.routers.payment_methods import ensure_default_methods
from app.schemas import HotelBody, HotelOut, HotelPatch, UserBody, UserOut, UserPatch
from app.security import hash_password

router = APIRouter(prefix="/api", tags=["hotels & users"])


def _bound_ids(db: Session, u: User) -> list[int]:
    """员工绑定集合（主店兜底在前）；platform_admin 恒空"""
    if u.role == "platform_admin":
        return []
    ids: list[int] = []
    if u.hotel_id is not None:
        ids.append(u.hotel_id)
    for r in db.query(UserHotel).filter(UserHotel.user_id == u.id).all():
        if r.hotel_id not in ids:
            ids.append(r.hotel_id)
    return ids


def _user_out(db: Session, u: User) -> UserOut:
    """序列化员工：绑定集合一次查询（主店在前），hotel_name = 主店名"""
    h = db.get(Hotel, u.hotel_id) if u.hotel_id else None
    bound = _bound_ids(db, u)
    names = {x.id: x.name for x in db.query(Hotel).filter(Hotel.id.in_(bound)).all()} if bound else {}
    return UserOut(
        id=u.id, name=u.name, username=u.username, role=u.role,
        role_label=ROLE_LABELS.get(u.role, u.role),
        hotel_id=u.hotel_id, hotel_name=h.name if h else None,
        hotels=[{"id": hid, "name": names[hid]} for hid in bound if hid in names],
        is_active=u.is_active, last_login_at=u.last_login_at,
    )


def _apply_hotel_bindings(db: Session, target: User, hotel_ids: list[int]) -> None:
    """整体替换绑定集合（调用方先做校验与变更摘要；去重保序，第一个即主店）"""
    db.query(UserHotel).filter(UserHotel.user_id == target.id).delete(synchronize_session=False)
    for hid in dict.fromkeys(hotel_ids):
        db.add(UserHotel(user_id=target.id, hotel_id=hid))


@router.get("/hotels", response_model=list[HotelOut])
def list_hotels(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    q = db.query(Hotel)
    if user.role != "platform_admin":
        # 员工看主店 + 绑定集合内的酒店（多店员工登录后顶栏切换）
        q = q.filter(Hotel.id.in_(_bound_ids(db, user)))
    hotels = q.order_by(Hotel.id).all()
    out = []
    for h in hotels:
        out.append(HotelOut(
            id=h.id, name=h.name, city=h.city, address=h.address,
            contact_name=h.contact_name, is_active=h.is_active,
            room_count=db.query(Room).filter(Room.hotel_id == h.id).count(),
            staff_count=db.query(User).filter(User.hotel_id == h.id).count(),
            status="营业中" if h.is_active else "筹备中",
        ))
    return out


@router.post("/hotels", response_model=HotelOut)
def create_hotel(body: HotelBody, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    require_platform_admin(user)
    h = Hotel(name=body.name, city=body.city, address=body.address, contact_name=body.contact_name)
    db.add(h)
    db.flush()
    # 新店开张即有默认收款方式（渠道无此步骤是历史行为，暂不补）
    ensure_default_methods(db, h.id)
    log_op(db, h.id, user, "hotel_create", "hotel", h.id, f"创建酒店「{h.name}」")
    db.commit()
    return HotelOut(id=h.id, name=h.name, city=h.city, address=h.address,
                    contact_name=h.contact_name, is_active=h.is_active)


@router.patch("/hotels/{hotel_id}", response_model=HotelOut)
def patch_hotel(hotel_id: int, body: HotelPatch, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """编辑酒店信息（仅平台管理员）：null=不改，无实际变化不打日志"""
    require_platform_admin(user)
    h = db.get(Hotel, hotel_id)
    if not h:
        raise HTTPException(404, "酒店不存在")
    new_name = body.name.strip() if body.name is not None else None
    if new_name is not None and not new_name:
        raise HTTPException(400, "酒店名称不能为空")

    changes: list[str] = []
    if new_name is not None and new_name != h.name:
        changes.append(f"名称 {h.name}→{new_name}")
        h.name = new_name
    if body.city is not None and body.city.strip() != h.city:
        changes.append(f"城市 {h.city or '空'}→{body.city.strip()}")
        h.city = body.city.strip()
    if body.address is not None and body.address.strip() != h.address:
        changes.append(f"地址 {h.address or '空'}→{body.address.strip()}")
        h.address = body.address.strip()
    if body.contact_name is not None and body.contact_name.strip() != h.contact_name:
        changes.append(f"店长姓名 {h.contact_name or '空'}→{body.contact_name.strip()}")
        h.contact_name = body.contact_name.strip()
    if body.is_active is not None and body.is_active != h.is_active:
        changes.append(f"状态 {'筹备中' if h.is_active else '营业中'}→{'营业中' if body.is_active else '筹备中'}")
        h.is_active = body.is_active

    if not changes:
        return HotelOut(id=h.id, name=h.name, city=h.city, address=h.address,
                        contact_name=h.contact_name, is_active=h.is_active)
    log_op(db, h.id, user, "hotel_update", "hotel", h.id,
           f"更新酒店「{h.name}」：{' · '.join(changes)}")
    db.commit()
    return HotelOut(id=h.id, name=h.name, city=h.city, address=h.address,
                    contact_name=h.contact_name, is_active=h.is_active)


@router.get("/users", response_model=list[UserOut])
def list_users(hotel_id: int | None = None, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    q = db.query(User)
    if user.role == "platform_admin":
        if hotel_id:
            q = q.filter(User.hotel_id == hotel_id)
    else:
        # 酒店 admin 看绑定集合内酒店的员工（多店 admin 可跨店查看）
        bound = _bound_ids(db, user)
        q = q.filter(User.hotel_id.in_(bound))
    users = q.order_by(User.id).all()
    return [_user_out(db, u) for u in users]


@router.post("/users", response_model=UserOut)
def create_user(body: UserBody, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    # 平台管理员可为任意酒店建号（可绑多店）；酒店管理员只能为本店建号
    if user.role == "platform_admin":
        if body.hotel_id is None and not body.hotel_ids:
            raise HTTPException(400, "请选择所属酒店")
    elif user.role == "admin":
        # 酒店 admin 建号：绑定集合只允许本店（主店）
        if body.hotel_ids and set(body.hotel_ids) - {user.hotel_id}:
            raise HTTPException(400, "酒店管理员只能为本店创建员工账号")
    else:
        raise HTTPException(403, "无权限创建员工账号")

    # 绑定集合：hotel_ids 优先（第一个 = 主店）；缺省回落单店语义（body.hotel_id，再回落操作人本店）
    ids = list(dict.fromkeys(body.hotel_ids)) if body.hotel_ids else [body.hotel_id or user.hotel_id]
    if not ids or ids[0] is None:
        raise HTTPException(400, "请选择所属酒店")
    for hid in ids:
        if not db.get(Hotel, hid):
            raise HTTPException(400, f"酒店 {hid} 不存在")
    hotel_ids = ids

    if db.query(User).filter(User.username == body.username.strip()).first():
        raise HTTPException(400, "登录账号已存在")
    if len(body.password) < 6:
        raise HTTPException(400, "密码至少 6 位")
    u = User(
        hotel_id=hotel_ids[0],  # 主店 = 绑定集合第一个
        username=body.username.strip(),
        password_hash=hash_password(body.password),
        name=body.name,
        role=body.role,
    )
    db.add(u)
    db.flush()
    _apply_hotel_bindings(db, u, hotel_ids)
    h = db.get(Hotel, u.hotel_id)
    log_op(db, u.hotel_id, user, "user_create", "user", u.id,
           f"创建员工账号 {u.username}（{ROLE_LABELS.get(u.role, u.role)}）· {h.name if h else ''}"
           + (f" · 绑定 {len(hotel_ids)} 家酒店" if len(hotel_ids) > 1 else ""))
    db.commit()
    return _user_out(db, u)


@router.patch("/users/{user_id}", response_model=UserOut)
def patch_user(user_id: int, body: UserPatch, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(404, "员工不存在")
    if not can_access_hotel(db, user, u.hotel_id):
        raise HTTPException(403, "无权限编辑该员工")
    changes: list[str] = []
    if body.name is not None and body.name != u.name:
        changes.append(f"姓名 {u.name}→{body.name}")
        u.name = body.name
    if body.role is not None and body.role != u.role:
        changes.append(f"角色 {ROLE_LABELS.get(u.role, u.role)}→{ROLE_LABELS.get(body.role, body.role)}")
        u.role = body.role
    if body.is_active is not None and body.is_active != u.is_active:
        changes.append("状态 启用→停用" if not body.is_active else "状态 停用→启用")
        u.is_active = body.is_active
    if body.hotel_ids is not None and u.role != "platform_admin":
        # 整体替换绑定集合；第一个 = 新主店（users.hotel_id 跟随顺延）
        hotel_ids = list(dict.fromkeys(body.hotel_ids))
        if not hotel_ids:
            raise HTTPException(400, "至少绑定一家酒店")
        for hid in hotel_ids:
            if not db.get(Hotel, hid):
                raise HTTPException(400, f"酒店 {hid} 不存在")
        # 酒店 admin 只能在自己绑定集合内分配（通常=本店）
        if user.role == "admin" and set(hotel_ids) - set(_bound_ids(db, user)):
            raise HTTPException(400, "酒店管理员只能分配自己所属酒店的绑定")
        old = _bound_ids(db, u)
        if hotel_ids != old:
            hotels_rows = db.query(Hotel).filter(Hotel.id.in_(list(set(hotel_ids) | set(old)))).all()
            names = {x.id: x.name for x in hotels_rows}
            old_s = ",".join(names.get(i, str(i)) for i in old)
            new_s = ",".join(names.get(i, str(i)) for i in hotel_ids)
            changes.append(f"绑定酒店 {old_s}→{new_s}")
            _apply_hotel_bindings(db, u, hotel_ids)
            if u.hotel_id not in hotel_ids:
                changes.append(f"主店 {names.get(u.hotel_id, u.hotel_id)}→{names.get(hotel_ids[0], hotel_ids[0])}")
                u.hotel_id = hotel_ids[0]
    if not changes:
        return _user_out(db, u)
    log_op(db, u.hotel_id, user, "user_update", "user", u.id, f"更新员工 {u.name}（{u.username}）：{' · '.join(changes)}")
    db.commit()
    return _user_out(db, u)
