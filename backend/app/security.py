"""安全：密码哈希（PBKDF2，无外部依赖）、JWT 签发/校验、刷新令牌、PII 字段静态加密"""
import base64
import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone

import jwt
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.config import DATA_SECRET_KEY, JWT_EXPIRE_HOURS, JWT_SECRET

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


# ---- PII 字段静态加密（客人证件号）：AES-256-GCM，密钥来自 DATA_SECRET_KEY ----
# 目标：数据库泄露时证件号不可读（密钥只在应用配置，不落库）。API 层解密后仍返回明文
# （客户页明文口径不变），所以这是纯存储侧改造，前端零改动。enc1: 版本前缀为将来换钥留口。
_ENC_PREFIX = "enc1:"


def _field_key() -> bytes:
    """任意长度口令派生 32 字节 AES-256 密钥。"""
    return hashlib.sha256(DATA_SECRET_KEY.encode()).digest()


def encrypt_field(plain: str) -> str:
    """明文 → `enc1:` + base64(nonce ‖ 密文+GCM tag)。空值原样返回；已加密值幂等。"""
    if not plain or plain.startswith(_ENC_PREFIX):
        return plain
    nonce = os.urandom(12)
    sealed = AESGCM(_field_key()).encrypt(nonce, plain.encode(), None)
    return _ENC_PREFIX + base64.b64encode(nonce + sealed).decode()


def decrypt_field(stored: str) -> str:
    """`enc1:` 密文 → 明文。无前缀（存量明文/空串）原样返回；解密失败显式抛错不静默。"""
    if not stored.startswith(_ENC_PREFIX):
        return stored
    try:
        raw = base64.b64decode(stored[len(_ENC_PREFIX):])
        nonce, sealed = raw[:12], raw[12:]
        return AESGCM(_field_key()).decrypt(nonce, sealed, None).decode()
    except Exception as exc:
        raise ValueError("字段密文解密失败：DATA_SECRET_KEY 与加密时不一致或密文已损坏") from exc


def mask_id_number(value: str) -> str:
    """证件号日志脱敏：保留前 3 后 4，中间固定 ***——操作日志与库同泄露面，不落明文。"""
    if not value:
        return value
    if len(value) <= 7:
        return "*" * len(value)
    return f"{value[:3]}***{value[-4:]}"


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


def new_refresh_token() -> str:
    """不透明随机串（非 JWT）：DB 只存哈希，泄露库不等于泄露令牌"""
    return secrets.token_urlsafe(32)


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()
