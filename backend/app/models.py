"""数据模型：多店隔离，业务表均挂 hotel_id"""
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, Numeric, String, UniqueConstraint
from sqlalchemy.dialects.mysql import DATETIME as MYSQL_DATETIME
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

# 时间列统一用 DateTimeMS：MySQL 下渲染 DATETIME(6)（保留微秒）。⚠️ 不能用裸 DATETIME(0)——
# MySQL 对小数秒是四舍五入，`expires_at = now` 可能被舍到下一秒，登出后同一秒内刷新会
# 逃过过期判断掉进轮换宽限分支返回 200（SQLite 存全精度微秒无此问题）。
# 注意 SQLAlchemy 通用 DateTime 的首个位置参数是 timezone 不是精度，必须走 with_variant。
DateTimeMS = DateTime().with_variant(MYSQL_DATETIME(fsp=6), "mysql")

# 金额列统一用 Money：DECIMAL(12,2) 落库（保留到分），asdecimal=False 读出即 float
# （驱动层 Decimal→float 转换，业务算术仍走 Python 数字；规整统一走 deps.money）。
# 存量 MySQL 整数列由 db._MIGRATION_ALTERTYPES_NUMERIC 幂等 MODIFY 改型，数据自动保值。
Money = Numeric(12, 2, asdecimal=False)


class Hotel(Base):
    __tablename__ = "hotels"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    city: Mapped[str] = mapped_column(String(40), default="")
    address: Mapped[str] = mapped_column(String(120), default="")
    contact_name: Mapped[str] = mapped_column(String(40), default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTimeMS, default=datetime.now)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    hotel_id: Mapped[int | None] = mapped_column(ForeignKey("hotels.id"), nullable=True)
    username: Mapped[str] = mapped_column(String(40), unique=True)
    password_hash: Mapped[str] = mapped_column(String(200))
    name: Mapped[str] = mapped_column(String(40))
    role: Mapped[str] = mapped_column(String(20))  # platform_admin / admin / receptionist / housekeeper
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTimeMS, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTimeMS, default=datetime.now)


class RefreshToken(Base):
    """刷新令牌：DB 只存 SHA-256 哈希；轮换时旧记录置 revoked_at（留痕 60s 宽限）"""
    __tablename__ = "refresh_tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTimeMS)
    created_at: Mapped[datetime] = mapped_column(DateTimeMS, default=datetime.now)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTimeMS, nullable=True)


class Channel(Base):
    """预订来源渠道：颜色与展示顺序可配置"""
    __tablename__ = "channels"

    id: Mapped[int] = mapped_column(primary_key=True)
    hotel_id: Mapped[int] = mapped_column(ForeignKey("hotels.id"), index=True)
    name: Mapped[str] = mapped_column(String(40))
    color: Mapped[str] = mapped_column(String(9), default="#0071E3")
    sort_order: Mapped[int] = mapped_column(Integer, default=99)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class PayMethod(Base):
    """收款方式：前台收款 / 入住登记的下拉选项，各店独立配置。

    payments.method 存稳定 code（存量数据 cash/wechat/... 与默认项天然对齐），
    name 可随时改名，历史账目展示不受影响。
    """
    __tablename__ = "payment_methods"
    __table_args__ = (UniqueConstraint("hotel_id", "code", name="uq_paymethod_hotel_code"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    hotel_id: Mapped[int] = mapped_column(ForeignKey("hotels.id"), index=True)
    code: Mapped[str] = mapped_column(String(20))
    name: Mapped[str] = mapped_column(String(40))
    remark: Mapped[str] = mapped_column(String(120), default="")
    sort_order: Mapped[int] = mapped_column(Integer, default=99)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class RoomType(Base):
    __tablename__ = "room_types"

    id: Mapped[int] = mapped_column(primary_key=True)
    hotel_id: Mapped[int] = mapped_column(ForeignKey("hotels.id"), index=True)
    name: Mapped[str] = mapped_column(String(40))
    base_price: Mapped[float] = mapped_column(Money)
    # 兼容保留：单值钟点价（元/小时），仅作存量库回填档位的数据源，业务判断一律走 HourlyRate 档位表
    hourly_price: Mapped[float] = mapped_column(Money, default=0)
    capacity: Mapped[int] = mapped_column(Integer, default=2)
    description: Mapped[str] = mapped_column(String(120), default="")


class HourlyRate(Base):
    """房型钟点价档位：每档 = (hours, price)，price 是该时长的整单总价（如 2 小时/¥80）。

    钟点房售卖铁律按「房型是否配了档位」判定（无档位 = 不支持钟点房）；
    开单默认价 = 该时长精确命中的档位总价 ÷ 小时数（rate 仍是每小时单价，账目口径不变）。
    同房型小时数唯一（UniqueConstraint），防止同档重复配置。
    """
    __tablename__ = "hourly_rates"
    __table_args__ = (UniqueConstraint("room_type_id", "hours", name="uq_hourly_rate_type_hours"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    room_type_id: Mapped[int] = mapped_column(ForeignKey("room_types.id"), index=True)
    hotel_id: Mapped[int] = mapped_column(ForeignKey("hotels.id"), index=True)
    hours: Mapped[int] = mapped_column(Integer)  # 1–12
    price: Mapped[float] = mapped_column(Money)  # 该时长的整单总价


class Room(Base):
    __tablename__ = "rooms"

    id: Mapped[int] = mapped_column(primary_key=True)
    hotel_id: Mapped[int] = mapped_column(ForeignKey("hotels.id"), index=True)
    room_type_id: Mapped[int] = mapped_column(ForeignKey("room_types.id"))
    room_number: Mapped[str] = mapped_column(String(10))
    floor: Mapped[int] = mapped_column(Integer, default=1)
    # vacant_clean / vacant_dirty / occupied / maintenance
    status: Mapped[str] = mapped_column(String(20), default="vacant_clean")
    notes: Mapped[str] = mapped_column(String(120), default="")


class Guest(Base):
    __tablename__ = "guests"

    id: Mapped[int] = mapped_column(primary_key=True)
    hotel_id: Mapped[int] = mapped_column(ForeignKey("hotels.id"), index=True)
    name: Mapped[str] = mapped_column(String(40))
    phone: Mapped[str] = mapped_column(String(20), default="")
    # 证件号静态加密存储（security.encrypt_field，enc1: 前缀密文 ~69 字符，18 位证件号）；
    # API 层解密返回明文（客户页明文口径不变）。列宽 120 对存量 MySQL 库由 _MIGRATION_ALTERTYPES 放宽
    id_number: Mapped[str] = mapped_column(String(120), default="")
    vip_level: Mapped[str] = mapped_column(String(20), default="")
    notes: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(DateTimeMS, default=datetime.now)


class Reservation(Base):
    __tablename__ = "reservations"

    id: Mapped[int] = mapped_column(primary_key=True)
    hotel_id: Mapped[int] = mapped_column(ForeignKey("hotels.id"), index=True)
    code: Mapped[str] = mapped_column(String(20), unique=True)
    guest_id: Mapped[int] = mapped_column(ForeignKey("guests.id"))
    room_type_id: Mapped[int] = mapped_column(ForeignKey("room_types.id"))
    room_id: Mapped[int | None] = mapped_column(ForeignKey("rooms.id"), nullable=True)
    check_in: Mapped[date] = mapped_column(Date)
    check_out: Mapped[date] = mapped_column(Date)
    # 实际离店日：提前退房时早于 check_out（当天腾房，尾段/尾夜可续售）；正常退房等于 check_out；撤销退房清 NULL
    actual_check_out: Mapped[date | None] = mapped_column(Date, nullable=True)
    # 实际入住时刻：钟点房「到时 = actual_check_in + hours」的口径来源；办理入住写入，
    # 撤销入住清 NULL（再次入住覆盖）。整晚房不参与到时判断，但同样记录留痕
    actual_check_in: Mapped[datetime | None] = mapped_column(DateTimeMS, nullable=True)
    # pending / confirmed / checked_in / checked_out / cancelled / no_show
    status: Mapped[str] = mapped_column(String(20), default="confirmed")
    channel_id: Mapped[int | None] = mapped_column(ForeignKey("channels.id"), nullable=True)
    rate: Mapped[float] = mapped_column(Money, default=0)
    # stay_type: normal（整晚）/ hourly（钟点房）；hourly 时 hours 为入住时长（小时）
    stay_type: Mapped[str] = mapped_column(String(10), default="normal")
    hours: Mapped[int] = mapped_column(Integer, default=0)
    notes: Mapped[str] = mapped_column(String(200), default="")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTimeMS, default=datetime.now)


class FolioItem(Base):
    """账目明细：房费 / 杂费等费用记录"""
    __tablename__ = "folio_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    hotel_id: Mapped[int] = mapped_column(ForeignKey("hotels.id"), index=True)
    reservation_id: Mapped[int] = mapped_column(ForeignKey("reservations.id"), index=True)
    category: Mapped[str] = mapped_column(String(20), default="room_charge")  # room_charge / other
    description: Mapped[str] = mapped_column(String(120), default="")
    amount: Mapped[float] = mapped_column(Money, default=0)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTimeMS, default=datetime.now)


class Payment(Base):
    """收款：押金 / 结算均记录在此"""
    __tablename__ = "payments"

    id: Mapped[int] = mapped_column(primary_key=True)
    hotel_id: Mapped[int] = mapped_column(ForeignKey("hotels.id"), index=True)
    reservation_id: Mapped[int] = mapped_column(ForeignKey("reservations.id"), index=True)
    method: Mapped[str] = mapped_column(String(20), default="cash")  # cash / wechat / alipay / card
    amount: Mapped[float] = mapped_column(Money, default=0)
    remark: Mapped[str] = mapped_column(String(120), default="")  # 收款备注（选填，＋收款弹层录入）
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTimeMS, default=datetime.now)


class OperationLog(Base):
    """操作日志：经营报表单日明细展示谁在何时做了什么"""
    __tablename__ = "operation_logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    hotel_id: Mapped[int] = mapped_column(ForeignKey("hotels.id"), index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    operator_name: Mapped[str] = mapped_column(String(40), default="")
    action: Mapped[str] = mapped_column(String(30))  # reservation_create / check_in / check_out / payment / folio_add / room_status ...
    object_type: Mapped[str] = mapped_column(String(30), default="")  # reservation / room / payment / task
    object_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    summary: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(DateTimeMS, default=datetime.now)
