"""数据模型：多店隔离，业务表均挂 hotel_id"""
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Hotel(Base):
    __tablename__ = "hotels"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    city: Mapped[str] = mapped_column(String(40), default="")
    address: Mapped[str] = mapped_column(String(120), default="")
    contact_name: Mapped[str] = mapped_column(String(40), default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    hotel_id: Mapped[int | None] = mapped_column(ForeignKey("hotels.id"), nullable=True)
    username: Mapped[str] = mapped_column(String(40), unique=True)
    password_hash: Mapped[str] = mapped_column(String(200))
    name: Mapped[str] = mapped_column(String(40))
    role: Mapped[str] = mapped_column(String(20))  # platform_admin / admin / receptionist / housekeeper
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class Channel(Base):
    """预订来源渠道：颜色与展示顺序可配置"""
    __tablename__ = "channels"

    id: Mapped[int] = mapped_column(primary_key=True)
    hotel_id: Mapped[int] = mapped_column(ForeignKey("hotels.id"), index=True)
    name: Mapped[str] = mapped_column(String(40))
    color: Mapped[str] = mapped_column(String(9), default="#0071E3")
    sort_order: Mapped[int] = mapped_column(Integer, default=99)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class RoomType(Base):
    __tablename__ = "room_types"

    id: Mapped[int] = mapped_column(primary_key=True)
    hotel_id: Mapped[int] = mapped_column(ForeignKey("hotels.id"), index=True)
    name: Mapped[str] = mapped_column(String(40))
    base_price: Mapped[int] = mapped_column(Integer)
    capacity: Mapped[int] = mapped_column(Integer, default=2)
    description: Mapped[str] = mapped_column(String(120), default="")


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
    id_number: Mapped[str] = mapped_column(String(40), default="")
    vip_level: Mapped[str] = mapped_column(String(20), default="")
    notes: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


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
    # pending / confirmed / checked_in / checked_out / cancelled / no_show
    status: Mapped[str] = mapped_column(String(20), default="confirmed")
    channel_id: Mapped[int | None] = mapped_column(ForeignKey("channels.id"), nullable=True)
    rate: Mapped[int] = mapped_column(Integer, default=0)
    notes: Mapped[str] = mapped_column(String(200), default="")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class FolioItem(Base):
    """账目明细：房费 / 杂费等费用记录"""
    __tablename__ = "folio_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    hotel_id: Mapped[int] = mapped_column(ForeignKey("hotels.id"), index=True)
    reservation_id: Mapped[int] = mapped_column(ForeignKey("reservations.id"), index=True)
    category: Mapped[str] = mapped_column(String(20), default="room_charge")  # room_charge / other
    description: Mapped[str] = mapped_column(String(120), default="")
    amount: Mapped[int] = mapped_column(Integer, default=0)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class Payment(Base):
    """收款：押金 / 结算均记录在此"""
    __tablename__ = "payments"

    id: Mapped[int] = mapped_column(primary_key=True)
    hotel_id: Mapped[int] = mapped_column(ForeignKey("hotels.id"), index=True)
    reservation_id: Mapped[int] = mapped_column(ForeignKey("reservations.id"), index=True)
    method: Mapped[str] = mapped_column(String(20), default="cash")  # cash / wechat / alipay / card
    amount: Mapped[int] = mapped_column(Integer, default=0)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class HousekeepingTask(Base):
    __tablename__ = "housekeeping_tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    hotel_id: Mapped[int] = mapped_column(ForeignKey("hotels.id"), index=True)
    room_id: Mapped[int] = mapped_column(ForeignKey("rooms.id"))
    task_type: Mapped[str] = mapped_column(String(20), default="checkout")  # checkout / daily / deep / repair / inspection
    # pending / in_progress / done
    status: Mapped[str] = mapped_column(String(20), default="pending")
    priority: Mapped[str] = mapped_column(String(10), default="mid")  # high / mid / low
    assignee: Mapped[str] = mapped_column(String(40), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class OperationLog(Base):
    """操作日志：经营报表单日明细展示谁在何时做了什么"""
    __tablename__ = "operation_logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    hotel_id: Mapped[int] = mapped_column(ForeignKey("hotels.id"), index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    operator_name: Mapped[str] = mapped_column(String(40), default="")
    action: Mapped[str] = mapped_column(String(30))  # reservation_create / reservation_confirm / check_in / check_out / payment / folio_add / housekeeping_done / room_status ...
    object_type: Mapped[str] = mapped_column(String(30), default="")  # reservation / room / payment / task
    object_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    summary: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)
