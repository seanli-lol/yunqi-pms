"""认证：账号密码直登（员工默认主店，绑定多店登录后切换）+ 滑块验证码 + 刷新令牌续期"""
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

import app.captcha as captcha
from app.config import JWT_EXPIRE_HOURS, REFRESH_TOKEN_DAYS, ROLE_LABELS
from app.deps import bound_hotel_ids, get_current_user
from app.db import get_db
from app.models import Hotel, RefreshToken, User
from app.schemas import (
    CaptchaResult,
    CaptchaVerifyBody,
    CaptchaVerifyResult,
    LoginBody,
    LoginResult,
    RefreshBody,
    RefreshResult,
    UserInfo,
)
from app.security import create_token, hash_token, new_refresh_token, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])

# 简易登录限流：每 IP 每分钟最多 10 次尝试（演示级防护，生产建议接入 Redis/网关）
_login_attempts: dict[str, deque] = defaultdict(lambda: deque(maxlen=10))
# 验证码出图单独限流：每 IP 每分钟 30 次（防止刷图耗 CPU）
_captcha_hits: dict[str, deque] = defaultdict(lambda: deque(maxlen=30))

# 刷新令牌轮换宽限期：旧令牌换新后 60s 内仍可用（多标签页并发续期不互相踢下线）
_REFRESH_GRACE_SECONDS = 60


def _throttled(store: dict[str, deque], ip: str, limit: int) -> bool:
    now = time.time()
    q = store[ip]
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= limit:
        return True
    q.append(now)
    return False


def _rate_limited(ip: str) -> bool:
    return _throttled(_login_attempts, ip, 10)


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _issue_refresh(db: Session, user: User) -> str:
    """签发刷新令牌：DB 只落哈希，返回明文给客户端"""
    raw = new_refresh_token()
    db.add(RefreshToken(
        user_id=user.id,
        token_hash=hash_token(raw),
        expires_at=datetime.now() + timedelta(days=REFRESH_TOKEN_DAYS),
    ))
    return raw


def _login_result(db: Session, user: User, hotel_name: str | None) -> LoginResult:
    refresh_raw = _issue_refresh(db, user)
    db.commit()
    return LoginResult(
        token=create_token(user.id, user.hotel_id, user.role, user.name),
        refresh_token=refresh_raw,
        expires_in=JWT_EXPIRE_HOURS * 3600,
        user=UserInfo(
            id=user.id,
            name=user.name,
            username=user.username,
            role=user.role,
            role_label=ROLE_LABELS.get(user.role, user.role),
            hotel_id=user.hotel_id,
            hotel_name=hotel_name,
            hotel_ids=[] if user.role == "platform_admin" else bound_hotel_ids(db, user),
        ),
        hotel_name=hotel_name,
    )


@router.get("/captcha", response_model=CaptchaResult)
def get_captcha(request: Request):
    if not captcha.enabled():
        return CaptchaResult(enabled=False)
    if _throttled(_captcha_hits, _client_ip(request), 30):
        raise HTTPException(429, "请求过于频繁，请稍后再试")
    return CaptchaResult(enabled=True, **captcha.new_challenge())


@router.post("/captcha/verify", response_model=CaptchaVerifyResult)
def verify_captcha(body: CaptchaVerifyBody):
    ticket = captcha.verify(body.id, body.x)
    if not ticket:
        raise HTTPException(400, "验证未通过，请重试")
    return CaptchaVerifyResult(ok=True, captcha_token=ticket)


@router.post("/login", response_model=LoginResult)
def login(body: LoginBody, request: Request, db: Session = Depends(get_db)):
    client_ip = _client_ip(request)
    if _rate_limited(client_ip):
        raise HTTPException(429, "尝试过于频繁，请稍后再试")
    # 验证码先于凭据校验（票据一次性：本次登录失败也作废，须重新滑动）
    if not captcha.consume(body.captcha_token):
        raise HTTPException(400, "请先完成滑块验证")

    # 账号密码直登，不再选酒店：员工默认主店，绑定多店的登录后在顶栏切换；
    # body.hotel_id 已废弃（历史客户端/dev-login 传入一律忽略）。
    user = db.query(User).filter(User.username == body.username.strip()).first()
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(400, "账号或密码不正确")
    if not user.is_active:
        raise HTTPException(403, "账号已停用，请联系管理员")

    hotel_name = None
    if user.hotel_id is not None:
        hotel = db.get(Hotel, user.hotel_id)
        hotel_name = hotel.name if hotel else None

    user.last_login_at = datetime.now()
    return _login_result(db, user, hotel_name)


@router.post("/refresh", response_model=RefreshResult)
def refresh(body: RefreshBody, db: Session = Depends(get_db)):
    """刷新令牌换新访问令牌（滑动窗口轮换：每次续期重新计 7 天）"""
    rec = db.query(RefreshToken).filter(RefreshToken.token_hash == hash_token(body.refresh_token)).first()
    now = datetime.now()
    if rec is None:
        raise HTTPException(401, "登录已过期，请重新登录")
    if rec.expires_at < now:
        raise HTTPException(401, "登录已过期，请重新登录")
    if rec.revoked_at is not None:
        if (now - rec.revoked_at).total_seconds() > _REFRESH_GRACE_SECONDS:
            # 已轮换的旧令牌被再次使用且超出宽限：视为泄露，
            # 直接删除该用户所有未吊销的令牌（删除后一律 401，不会再走宽限路径）
            db.query(RefreshToken).filter(
                RefreshToken.user_id == rec.user_id, RefreshToken.revoked_at.is_(None)
            ).delete(synchronize_session=False)
            db.commit()
            raise HTTPException(401, "登录状态异常，请重新登录")
        # 宽限期内：允许换新（多标签页并发续期）；不再刷新 revoked_at，避免宽限被无限续上
    else:
        rec.revoked_at = now
    user = db.get(User, rec.user_id)
    if user is None or not user.is_active:
        raise HTTPException(401, "账号不存在或已停用")

    new_raw = _issue_refresh(db, user)
    db.commit()
    return RefreshResult(
        token=create_token(user.id, user.hotel_id, user.role, user.name),
        refresh_token=new_raw,
        expires_in=JWT_EXPIRE_HOURS * 3600,
    )


@router.post("/logout")
def logout(body: RefreshBody, db: Session = Depends(get_db)):
    """退出登录：吊销刷新令牌（令牌不存在也返回 200，避免探测）

    同时把 expires_at 置为当前时间——轮换宽限期只服务于「旧令牌并发续期」，
    主动登出必须立刻失效，不能被 60s 宽限捞回来。
    """
    rec = db.query(RefreshToken).filter(RefreshToken.token_hash == hash_token(body.refresh_token)).first()
    if rec is not None and rec.revoked_at is None:
        now = datetime.now()
        rec.revoked_at = now
        rec.expires_at = now
        db.commit()
    return {"ok": True}


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
        hotel_ids=[] if user.role == "platform_admin" else bound_hotel_ids(db, user),
    )
