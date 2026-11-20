"""应用配置：路径、密钥、常量（支持 backend/.env 本地配置文件）"""
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_env_file() -> None:
    """加载本地 .env（backend/.env 优先于项目根 .env）。

    规则：**已在环境变量里的值不被覆盖**（shell 显式 export / pytest 里 os.environ 设置优先级最高）；
    因此按优先级从高到低依次 setdefault —— backend/.env 先读，根 .env 只补它没定义的键。
    格式：KEY=VALUE，忽略空行与 # 注释，允许行内去掉包裹的引号。不做变量展开（保持简单可预期）。
    """
    root = os.path.dirname(BASE_DIR)
    for path in (os.path.join(BASE_DIR, ".env"), os.path.join(root, ".env")):
        if not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, value = line.split("=", 1)
                    key, value = key.strip(), value.strip()
                    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                        value = value[1:-1]
                    if key:
                        os.environ.setdefault(key, value)
        except OSError:
            continue


_load_env_file()

DB_PATH = os.environ.get("YUNQI_DB", os.path.join(BASE_DIR, "pms.db"))
DATABASE_URL = f"sqlite:///{DB_PATH}"

# 开发用密钥；生产环境请通过环境变量覆盖
JWT_SECRET = os.environ.get("YUNQI_JWT_SECRET", "yunqi-pms-dev-secret-2026")
# 访问令牌（JWT）有效期；到期由前端用刷新令牌静默续期
JWT_EXPIRE_HOURS = 2
# 刷新令牌有效期（滑动窗口：每次续期都从当下重新计时）
REFRESH_TOKEN_DAYS = 7
# 登录滑块验证码开关：.env 里写 YUNQI_CAPTCHA=off 可关闭（本地开发/自动化常用）
CAPTCHA_ENABLED = os.environ.get("YUNQI_CAPTCHA", "on").lower() not in ("off", "0", "false", "no")

# 前端开发地址（CORS）
FRONTEND_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]

ROOM_STATUSES = ("vacant_clean", "vacant_dirty", "occupied", "maintenance")
RES_STATUSES = ("pending", "confirmed", "checked_in", "checked_out", "cancelled", "no_show")
USER_ROLES = ("platform_admin", "admin", "receptionist", "housekeeper")
ROLE_LABELS = {
    "platform_admin": "平台管理员",
    "admin": "管理员",
    "receptionist": "前台",
    "housekeeper": "客房部",
}
