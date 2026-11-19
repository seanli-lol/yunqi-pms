"""认证：酒店员工（酒店+账号+密码）/ 平台管理员（账号+密码）登录"""
import time
from collections import defaultdict, deque
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.config import ROLE_LABELS
from app.deps import get_current_user
from app.db import get_db
from app.models import Hotel, User
from app.schemas import LoginBody, LoginResult, UserInfo
from app.security import create_token, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])

# 简易登录限流：每 IP 每分钟最多 10 次尝试（演示级防护，生产建议接入 Redis/网关）
_login_attempts: dict[str, deque] = defaultdict(lambda: deque(maxlen=10))


def _rate_limited(ip: str) -> bool:
    now = time.time()
    q = _login_attempts[ip]
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= 10:
        return True
    q.append(now)
    return False


@router.post("/login", response_model=LoginResult)
def login(body: LoginBody, request: Request, db: Session = Depends(get_db)):
    client_ip = request.client.host if request.client else "unknown"
    if _rate_limited(client_ip):
        raise HTTPException(429, "尝试过于频繁，请稍后再试")

    user = db.query(User).filter(User.username == body.username.strip()).first()
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(400, "账号或密码不正确")
    if not user.is_active:
        raise HTTPException(403, "账号已停用，请联系管理员")

    hotel_name = None
    if user.hotel_id is not None:
        # 员工：必须选择所属酒店
        if body.hotel_id is None:
            raise HTTPException(400, "请选择所属酒店")
        if body.hotel_id != user.hotel_id:
            raise HTTPException(400, "所选酒店与该账号不匹配")
        hotel = db.get(Hotel, user.hotel_id)
        hotel_name = hotel.name if hotel else None
    # 平台管理员：无需酒店，直接登录

    user.last_login_at = datetime.now()
    db.commit()

    token = create_token(user.id, user.hotel_id, user.role, user.name)
    return LoginResult(
        token=token,
        user=UserInfo(
            id=user.id,
            name=user.name,
            username=user.username,
            role=user.role,
            role_label=ROLE_LABELS.get(user.role, user.role),
            hotel_id=user.hotel_id,
            hotel_name=hotel_name,
        ),
        hotel_name=hotel_name,
    )


@router.get("/me", response_model=UserInfo)
def me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    hotel_name = None
    if user.hotel_id:
        hotel = db.get(Hotel, user.hotel_id)
        hotel_name = hotel.name if hotel else None
    return UserInfo(
        id=user.id,
        name=user.name,
        username=user.username,
        role=user.role,
        role_label=ROLE_LABELS.get(user.role, user.role),
        hotel_id=user.hotel_id,
        hotel_name=hotel_name,
    )
