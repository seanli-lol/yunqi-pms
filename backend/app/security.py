"""安全：密码哈希（PBKDF2，无外部依赖）与 JWT 签发/校验"""
import hashlib
import hmac
import os
from datetime import datetime, timedelta, timezone

import jwt

from app.config import JWT_EXPIRE_HOURS, JWT_SECRET

_ITERATIONS = 60_000


def hash_password(password: str) -> str:
    salt = os.urandom(16).hex()
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), _ITERATIONS).hex()
    return f"{salt}${digest}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt, expected = stored.split("$", 1)
    except ValueError:
        return False
    calc = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), _ITERATIONS).hex()
    return hmac.compare_digest(calc, expected)


def create_token(user_id: int, hotel_id: int | None, role: str, name: str) -> str:
    payload = {
        "sub": str(user_id),
        "hotel_id": hotel_id,
        "role": role,
        "name": name,
        "exp": datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRE_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def decode_token(token: str) -> dict:
    payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    return payload
