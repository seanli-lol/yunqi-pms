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
    hourly_price: int = 0  # 钟点房价（元/小时）；0 = 不支持钟点房
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
    stay_type: Literal["normal", "hourly"] = "normal"
    hours: int = 0                    # 钟点房：入住时长（小时）
    notes: str = ""
    status: Literal["pending", "confirmed"] = "confirmed"


class ReservationPatch(BaseModel):
    """拖动换房 / 改期 / 调整预订（日期、房价）"""
    room_id: int | None = None
    check_in: date | None = None
    check_out: date | None = None
    rate: int | None = None           # 房价单价（前端按整单总额折算）


class RegistrationBody(BaseModel):
    """在住登记信息更正（姓名 / 手机号 / 天数 / 房价 / 来源 / 备注）。

    字段为 None 表示不修改；房价或天数改动会按新口径重算首条房费账目。"""
    guest_name: str | None = None
    guest_phone: str | None = None
    nights: int | None = None         # 普通房：改入住天数（离店日 = 入住日 + 天数）
    rate: int | None = None
    channel_id: int | None = None
    notes: str | None = None


class PaidTotalBody(BaseModel):
    """更正实收：把该预订的已收款合计调整到目标整单总额。

    amount > 当前已收 → 补一笔收款（使用 method）；amount < 当前已收 → 从最新一笔起冲减。
    """
    amount: int
    method: Literal["cash", "wechat", "alipay", "card"] = "cash"


class ExtendBody(BaseModel):
    """延住：普通预订按晚数延长，钟点预订按小时延长"""
    nights: int = 1
    hours: int = 0
    rate: int | None = None           # 应收单价（默认取预订当前 rate）


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
    # 房间当前房态（已离店预订据此决定是否提供「转为净房」）
    room_status: str | None = None
    check_in: date
    check_out: date
    # 实际离店日（提前退房时早于 check_out，供日历截断与「实住」展示）
    actual_check_out: date | None = None
    nights: int
    status: str
    channel_id: int | None
    channel_name: str | None
    channel_color: str | None
    rate: int
    stay_type: str
    hours: int
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
