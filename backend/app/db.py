"""数据库：引擎、会话、模型基类 + 轻量 SQLite 迁移"""
from sqlalchemy import create_engine, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import DATABASE_URL

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
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


def run_sqlite_migrations() -> None:
    with engine.begin() as conn:
        for table, column, ddl in _MIGRATION_COLUMNS:
            cols = {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))}
            if column not in cols:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
