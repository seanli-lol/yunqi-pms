"""应用配置：路径、密钥、常量"""
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.environ.get("YUNQI_DB", os.path.join(BASE_DIR, "pms.db"))
DATABASE_URL = f"sqlite:///{DB_PATH}"

# 开发用密钥；生产环境请通过环境变量覆盖
JWT_SECRET = os.environ.get("YUNQI_JWT_SECRET", "yunqi-pms-dev-secret-2026")
JWT_EXPIRE_HOURS = 12

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
