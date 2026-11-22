"""数据库：引擎、会话、模型基类 + 轻量通用迁移（SQLite / MySQL 两方言通用）"""
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import DATABASE_URL

# check_same_thread 是 SQLite 专属参数，MySQL（PyMySQL）不认识，按方言条件传入
_is_sqlite = DATABASE_URL.startswith("sqlite")
engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if _is_sqlite else {},
    pool_pre_ping=True,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# 轻量迁移：create_all 只建新表不改旧表，存量库缺列时在此补齐。
# 新增列时同步登记到 _MIGRATION_COLUMNS（幂等：已有列会跳过）。
_MIGRATION_COLUMNS = [
    ("room_types", "hourly_price", "INTEGER NOT NULL DEFAULT 0"),
    ("reservations", "stay_type", "VARCHAR(10) NOT NULL DEFAULT 'normal'"),
    ("reservations", "hours", "INTEGER NOT NULL DEFAULT 0"),
    ("reservations", "actual_check_out", "DATE NULL"),
    ("guests", "id_number", "VARCHAR(40) NOT NULL DEFAULT ''"),
    ("payments", "remark", "VARCHAR(120) NOT NULL DEFAULT ''"),
]


def run_db_migrations() -> None:
    """列存在性用 SQLAlchemy inspector 探测（SQLite/MySQL 通用），ALTER 语句两方言兼容。"""
    insp = inspect(engine)
    with engine.begin() as conn:
        for table, column, ddl in _MIGRATION_COLUMNS:
            if not insp.has_table(table):
                continue  # 防御：create_all 之前不会发生，存量库缺表时跳过
            cols = {c["name"] for c in insp.get_columns(table)}
            if column not in cols:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
