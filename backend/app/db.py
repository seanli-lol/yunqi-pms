"""数据库：引擎、会话、模型基类 + 轻量通用迁移（SQLite / MySQL 两方言通用）+ PII 存量回填"""
from sqlalchemy import Integer, create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import DATABASE_URL
from app.security import encrypt_field

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

# 列类型放宽：仅 MySQL 执行 MODIFY（SQLite 不强制 VARCHAR 长度，无需处理）。
# (table, column, 目标长度, 完整列 DDL)——当前列长度更短时执行，幂等。
_MIGRATION_ALTERTYPES = [
    ("guests", "id_number", 120, "VARCHAR(120) NOT NULL DEFAULT ''"),  # 证件号密文（enc1: ~69 字符）
]

# 金额列改型（INT → DECIMAL(12,2)，保留到分）：仅 MySQL 执行 MODIFY，存量整数数据自动保值。
# 幂等守卫用「反射类型仍是整型才改」——不能复用上面 _MIGRATION_ALTERTYPES 的 .length 判断
# （MySQL 反射出的 INTEGER 类型对象没有 .length 属性，会 AttributeError）；改完反射出
# DECIMAL 不再命中 isinstance(Integer)，重复启动直接跳过。SQLite 无 MODIFY，靠类型亲和
# 按实存值返回（模型层 Numeric(asdecimal=False) 读出即 float），测试库无需改列。
_MIGRATION_ALTERTYPES_NUMERIC = [
    ("room_types", "base_price", "DECIMAL(12,2) NOT NULL DEFAULT 0"),
    ("room_types", "hourly_price", "DECIMAL(12,2) NOT NULL DEFAULT 0"),
    ("reservations", "rate", "DECIMAL(12,2) NOT NULL DEFAULT 0"),
    ("folio_items", "amount", "DECIMAL(12,2) NOT NULL DEFAULT 0"),
    ("payments", "amount", "DECIMAL(12,2) NOT NULL DEFAULT 0"),
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
        if engine.dialect.name == "mysql":
            for table, column, target_len, ddl in _MIGRATION_ALTERTYPES:
                if not insp.has_table(table):
                    continue
                col = next((c for c in insp.get_columns(table) if c["name"] == column), None)
                if col and (col["type"].length or 0) < target_len:
                    conn.execute(text(f"ALTER TABLE {table} MODIFY {column} {ddl}"))
            for table, column, ddl in _MIGRATION_ALTERTYPES_NUMERIC:
                if not insp.has_table(table):
                    continue
                col = next((c for c in insp.get_columns(table) if c["name"] == column), None)
                if col and isinstance(col["type"], Integer):
                    conn.execute(text(f"ALTER TABLE {table} MODIFY {column} {ddl}"))


def backfill_encrypted_fields(db: Session) -> None:
    """存量明文证件号一次性加密回填（幂等：enc1: 前缀视为已加密跳过）。

    main.lifespan 在 ensure_seed 之前调用；密钥换掉的历史密文不在回填范围（解密交给 API 显式报错）。
    Guest 延迟导入：models.py 依赖本模块的 Base，模块级 import 会成环。
    """
    from app.models import Guest  # noqa: PLC0415

    rows = (db.query(Guest)
            .filter(Guest.id_number != "", ~Guest.id_number.like("enc1:%"))
            .all())
    for g in rows:
        g.id_number = encrypt_field(g.id_number)
    if rows:
        db.commit()
