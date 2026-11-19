"""酒店与员工管理：多店隔离的入口"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.config import ROLE_LABELS
from app.db import get_db
from app.deps import get_current_user, log_op, require_platform_admin
from app.models import Hotel, Room, User
from app.schemas import HotelBody, HotelOut, UserBody, UserOut, UserPatch
from app.security import hash_password

router = APIRouter(prefix="/api", tags=["hotels & users"])


@router.get("/hotels/public")
def public_hotels(db: Session = Depends(get_db)):
    """登录页使用：无需认证的酒店下拉列表"""
    hotels = db.query(Hotel).filter(Hotel.is_active).order_by(Hotel.id).all()
    return [{"id": h.id, "name": h.name} for h in hotels]


@router.get("/hotels", response_model=list[HotelOut])
def list_hotels(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    q = db.query(Hotel)
    if user.role != "platform_admin":
        q = q.filter(Hotel.id == user.hotel_id)
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
    log_op(db, h.id, user, "hotel_create", "hotel", h.id, f"创建酒店「{h.name}」")
    db.commit()
    return HotelOut(id=h.id, name=h.name, city=h.city, address=h.address,
                    contact_name=h.contact_name, is_active=h.is_active)


@router.patch("/hotels/{hotel_id}", response_model=HotelOut)
def patch_hotel(hotel_id: int, body: HotelBody, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    require_platform_admin(user)
    h = db.get(Hotel, hotel_id)
    if not h:
        raise HTTPException(404, "酒店不存在")
    h.name, h.city, h.address, h.contact_name = body.name, body.city, body.address, body.contact_name
    log_op(db, h.id, user, "hotel_update", "hotel", h.id, f"更新酒店信息「{h.name}」")
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
        q = q.filter(User.hotel_id == user.hotel_id)
    users = q.order_by(User.id).all()
    out = []
    for u in users:
        h = db.get(Hotel, u.hotel_id) if u.hotel_id else None
        out.append(UserOut(
            id=u.id, name=u.name, username=u.username, role=u.role,
            role_label=ROLE_LABELS.get(u.role, u.role),
            hotel_id=u.hotel_id, hotel_name=h.name if h else None,
            is_active=u.is_active, last_login_at=u.last_login_at,
        ))
    return out


@router.post("/users", response_model=UserOut)
def create_user(body: UserBody, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    # 平台管理员可为任意酒店建号；酒店管理员只能为本店建号
    if user.role == "platform_admin":
        if body.hotel_id is None:
            raise HTTPException(400, "请选择所属酒店")
        hotel_id = body.hotel_id
    elif user.role == "admin":
        hotel_id = user.hotel_id
    else:
        raise HTTPException(403, "无权限创建员工账号")
    if db.query(User).filter(User.username == body.username.strip()).first():
        raise HTTPException(400, "登录账号已存在")
    if len(body.password) < 6:
        raise HTTPException(400, "密码至少 6 位")
    u = User(
        hotel_id=hotel_id,
        username=body.username.strip(),
        password_hash=hash_password(body.password),
        name=body.name,
        role=body.role,
    )
    db.add(u)
    db.flush()
    h = db.get(Hotel, hotel_id)
    log_op(db, hotel_id, user, "user_create", "user", u.id,
           f"创建员工账号 {u.username}（{ROLE_LABELS.get(u.role, u.role)}）· {h.name if h else ''}")
    db.commit()
    h = db.get(Hotel, u.hotel_id) if u.hotel_id else None
    return UserOut(
        id=u.id, name=u.name, username=u.username, role=u.role,
        role_label=ROLE_LABELS.get(u.role, u.role),
        hotel_id=u.hotel_id, hotel_name=h.name if h else None,
        is_active=u.is_active, last_login_at=u.last_login_at,
    )


@router.patch("/users/{user_id}", response_model=UserOut)
def patch_user(user_id: int, body: UserPatch, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(404, "员工不存在")
    if user.role == "platform_admin":
        pass
    elif user.role == "admin" and u.hotel_id == user.hotel_id:
        pass
    else:
        raise HTTPException(403, "无权限编辑该员工")
    if body.name is not None:
        u.name = body.name
    if body.role is not None:
        u.role = body.role
    if body.is_active is not None:
        u.is_active = body.is_active
    log_op(db, u.hotel_id, user, "user_update", "user", u.id, f"更新员工 {u.name}（{u.username}）")
    db.commit()
    h = db.get(Hotel, u.hotel_id) if u.hotel_id else None
    return UserOut(
        id=u.id, name=u.name, username=u.username, role=u.role,
        role_label=ROLE_LABELS.get(u.role, u.role),
        hotel_id=u.hotel_id, hotel_name=h.name if h else None,
        is_active=u.is_active, last_login_at=u.last_login_at,
    )
