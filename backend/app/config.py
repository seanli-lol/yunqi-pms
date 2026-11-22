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
# mysql 连接参数：**无默认值**——DB_ENGINE=mysql 时五项必须全部显式配置，缺一启动即报错
DB_HOST = os.environ.get("DB_HOST")
DB_PORT = os.environ.get("DB_PORT")
DB_USER = os.environ.get("DB_USER")
DB_PASSWORD = os.environ.get("DB_PASSWORD")
DB_NAME = os.environ.get("DB_NAME")


def _database_url() -> str:
    """按引擎拼连接串。密码经 URL 编码（含 @ : / 等特殊字符也能连）；MySQL 全程 utf8mb4。

    DB_ENGINE=mysql 时连接参数不允许静默取默认值——缺失项直接列出并终止启动。
    """
    if DB_ENGINE != "mysql":
        return f"sqlite:///{DB_PATH}"
    missing = [
        key
        for key, value in (
            ("DB_HOST", DB_HOST),
            ("DB_PORT", DB_PORT),
            ("DB_USER", DB_USER),
            ("DB_PASSWORD", DB_PASSWORD),
            ("DB_NAME", DB_NAME),
        )
        if not value
    ]
    if missing:
        raise RuntimeError(
            "DB_ENGINE=mysql 需要显式配置数据库连接参数，当前缺失："
            + "、".join(missing)
            + "（在 backend/.env 里补齐，参考 .env.example 的 MySQL 段）"
        )
    return (
        f"mysql+pymysql://{quote_plus(DB_USER)}:{quote_plus(DB_PASSWORD)}"
        f"@{DB_HOST}:{DB_PORT}/{DB_NAME}?charset=utf8mb4"
    )


DATABASE_URL = _database_url()

# 开发用密钥；生产环境请通过环境变量覆盖
JWT_SECRET = os.environ.get("JWT_SECRET", "pms-dev-secret-2026")
# PII 字段静态加密密钥（客人证件号 AES-256-GCM 落库加密）。生产必须覆盖；一旦启用不可更换
# ——换钥后存量密文全部无法解密（decrypt_field 显式抛错）。
DATA_SECRET_KEY = os.environ.get("DATA_SECRET_KEY", "pms-dev-data-key-2026")
# 访问令牌（JWT）有效期；到期由前端用刷新令牌静默续期
JWT_EXPIRE_HOURS = 2
# 刷新令牌有效期（滑动窗口：每次续期都从当下重新计时）
REFRESH_TOKEN_DAYS = 7
# 登录滑块验证码开关：.env 里写 CAPTCHA=off 可关闭（本地开发/自动化常用）
CAPTCHA_ENABLED = os.environ.get("CAPTCHA", "on").lower() not in ("off", "0", "false", "no")
# seed 的 admin 初始密码：缺省 123456 与演示口径一致；生产部署用环境变量覆盖（首次建库生效）
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "123456")
# 演示员工账号开关：DEMO_ACCOUNTS=off 时 seed 把非 admin 账号建成停用态（生产部署防旁路登录）
DEMO_ACCOUNTS_ENABLED = os.environ.get("DEMO_ACCOUNTS", "on").lower() not in ("off", "0", "false", "no")

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
