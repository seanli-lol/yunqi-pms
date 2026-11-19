"""Pydantic 请求/响应模型"""
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field


# ---------- auth ----------
class LoginBody(BaseModel):
    hotel_id: int | None = None
    username: str
    password: str


class LoginResult(BaseModel):
    token: str
    user: "UserInfo"
    hotel_name: str | None = None


class UserInfo(BaseModel):
    id: int
    name: str
    username: str
    role: str
    role_label: str
    hotel_id: int | None = None
    hotel_name: str | None = None


# ---------- hotels ----------
class HotelBody(BaseModel):
    name: str
    city: str = ""
    address: str = ""
    contact_name: str = ""


class HotelOut(HotelBody):
    id: int
    is_active: bool
    room_count: int = 0
    staff_count: int = 0
    status: str = "营业中"


# ---------- users ----------
class UserBody(BaseModel):
    name: str
    username: str
    password: str
    role: Literal["admin", "receptionist", "housekeeper"]
    hotel_id: int | None = None


class UserPatch(BaseModel):
    name: str | None = None
    role: Literal["admin", "receptionist", "housekeeper"] | None = None
    is_active: bool | None = None


class UserOut(BaseModel):
    id: int
    name: str
    username: str
    role: str
    role_label: str
    hotel_id: int | None
    hotel_name: str | None = None
    is_active: bool
    last_login_at: datetime | None = None


# ---------- channels ----------
class ChannelBody(BaseModel):
    name: str
    color: str = "#0071E3"
    sort_order: int | None = None


class ChannelPatch(BaseModel):
    name: str | None = None
    color: str | None = None
    sort_order: int | None = None
    is_active: bool | None = None


class ChannelOut(ChannelBody):
    id: int
    sort_order: int
    is_active: bool


# ---------- room types ----------
class RoomTypeBody(BaseModel):
    name: str
    base_price: int
    capacity: int = 2
    description: str = ""


class RoomTypeOut(RoomTypeBody):
    id: int
    room_count: int = 0


# ---------- rooms ----------
class RoomBody(BaseModel):
    room_number: str
    floor: int = 1
    room_type_id: int
    notes: str = ""


class RoomPatch(BaseModel):
    status: Literal["vacant_clean", "vacant_dirty", "occupied", "maintenance"] | None = None
    notes: str | None = None


class RoomOut(BaseModel):
    id: int
    room_number: str
    floor: int
    status: str
    notes: str
    room_type_id: int
    room_type_name: str
    base_price: int


# ---------- reservations ----------
class ReservationBody(BaseModel):
    guest_name: str
    guest_phone: str = ""
    guest_id_number: str = ""
    check_in: date
    check_out: date
    room_type_id: int | None = None
    room_id: int | None = None        # 房态盘直接预订：锁定房号
    channel_id: int | None = None
    rate: int | None = None
    notes: str = ""
    status: Literal["pending", "confirmed"] = "confirmed"


class ReservationPatch(BaseModel):
    """拖动换房 / 改期"""
    room_id: int | None = None
    check_in: date | None = None
    check_out: date | None = None


class CheckInBody(BaseModel):
    room_id: int
    amount_received: int = 0
    payment_method: Literal["cash", "wechat", "alipay", "card"] = "cash"


class CheckOutBody(BaseModel):
    force: bool = False
    payments: list["PaymentBody"] = []


class PaymentBody(BaseModel):
    method: Literal["cash", "wechat", "alipay", "card"]
    amount: int


class FolioItemBody(BaseModel):
    category: Literal["room_charge", "other"] = "other"
    description: str
    amount: int


class ReservationOut(BaseModel):
    id: int
    code: str
    guest_id: int
    guest_name: str
    guest_phone: str
    vip_level: str
    room_type_id: int
    room_type_name: str
    room_id: int | None
    room_number: str | None
    check_in: date
    check_out: date
    nights: int
    status: str
    channel_id: int | None
    channel_name: str | None
    channel_color: str | None
    rate: int
    notes: str
    balance_due: int
    operator_name: str | None
    created_at: datetime


# ---------- guests ----------
class GuestBody(BaseModel):
    name: str
    phone: str = ""
    id_number: str = ""
    vip_level: str = ""
    notes: str = ""


class GuestOut(GuestBody):
    id: int
    stay_count: int = 0
    total_spend: int = 0
    last_stay: str | None = None


class GuestDetail(GuestOut):
    history: list[dict] = []


# ---------- housekeeping ----------
class TaskBody(BaseModel):
    room_id: int
    task_type: Literal["checkout", "daily", "deep", "repair", "inspection"] = "daily"
    priority: Literal["high", "mid", "low"] = "mid"
    assignee: str = ""
    notes: str = ""


class TaskOut(BaseModel):
    id: int
    room_id: int
    room_number: str
    room_type_name: str
    floor: int
    task_type: str
    status: str
    priority: str
    assignee: str
    notes: str
    created_at: datetime | None = None
    completed_at: datetime | None = None


# ---------- reports ----------
class RangeQuery(BaseModel):
    from_date: date
    to_date: date


class SummaryOut(BaseModel):
    occupancy: float
    adr: float
    revpar: float
    revenue_total: int
    revenue_room: int
    revenue_other: int
    days: int
    rooms: int


class DayOut(BaseModel):
    date: date
    occupancy: float
    revenue: int
    revenue_room: int
    revenue_other: int
    arrivals: int
    departures: int
    operations: list[dict]


LoginResult.model_rebuild()
CheckOutBody.model_rebuild()
