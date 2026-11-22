"""应用配置：路径、密钥、常量（支持 backend/.env 本地配置文件）"""
import os
from urllib.parse import quote_plus

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

# ---- 数据库 ----
# 引擎：sqlite（缺省，本地文件）| mysql（docker compose 起库后切换）
DB_ENGINE = os.environ.get("DB_ENGINE", "sqlite").lower()
# sqlite 专用：库文件路径（删掉该文件会重建演示数据）
DB_PATH = os.environ.get("DB_PATH", os.path.join(BASE_DIR, "pms.db"))
# mysql 连接参数（默认值与 docker-compose.yml 一致：起好库后 .env 写 DB_ENGINE=mysql 即可直连）
DB_HOST = os.environ.get("DB_HOST", "127.0.0.1")
DB_PORT = int(os.environ.get("DB_PORT", "3306"))
DB_USER = os.environ.get("DB_USER", "pms")
DB_PASSWORD = os.environ.get("DB_PASSWORD", "pms123456")
DB_NAME = os.environ.get("DB_NAME", "pms")


def _database_url() -> str:
    """按引擎拼连接串。密码经 URL 编码（含 @ : / 等特殊字符也能连）；MySQL 全程 utf8mb4。"""
    if DB_ENGINE != "mysql":
        return f"sqlite:///{DB_PATH}"
    return (
        f"mysql+pymysql://{quote_plus(DB_USER)}:{quote_plus(DB_PASSWORD)}"
        f"@{DB_HOST}:{DB_PORT}/{DB_NAME}?charset=utf8mb4"
    )


DATABASE_URL = _database_url()

# 开发用密钥；生产环境请通过环境变量覆盖
JWT_SECRET = os.environ.get("JWT_SECRET", "pms-dev-secret-2026")
# 访问令牌（JWT）有效期；到期由前端用刷新令牌静默续期
JWT_EXPIRE_HOURS = 2
# 刷新令牌有效期（滑动窗口：每次续期都从当下重新计时）
REFRESH_TOKEN_DAYS = 7
# 登录滑块验证码开关：.env 里写 CAPTCHA=off 可关闭（本地开发/自动化常用）
CAPTCHA_ENABLED = os.environ.get("CAPTCHA", "on").lower() not in ("off", "0", "false", "no")

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
