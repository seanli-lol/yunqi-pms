"""Pydantic 请求/响应模型"""
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, Field


def _to_money(v: float) -> float:
    """入参金额规整到分（四舍五入 half-up）：容忍浮点尾差，超过两位小数的入参按分落账。"""
    return float(Decimal(str(v)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


# 金额入参类型：float 基型（旧前端传 int 自动兼容）+ 规整到分
Money = Annotated[float, AfterValidator(_to_money)]


# ---------- auth ----------
class LoginBody(BaseModel):
    hotel_id: int | None = None
    username: str
    password: str
    # 滑块验证码通过后的一次性票据（验证码关闭时可为空）
    captcha_token: str | None = None


class LoginResult(BaseModel):
    token: str
    refresh_token: str
    expires_in: int  # 访问令牌剩余秒数（前端据此提前静默续期）
    user: "UserInfo"
    hotel_name: str | None = None


class RefreshBody(BaseModel):
    refresh_token: str


class RefreshResult(BaseModel):
    token: str
    refresh_token: str
    expires_in: int


class CaptchaResult(BaseModel):
    enabled: bool
    id: str | None = None
    bg: str | None = None
    piece: str | None = None
    y: int | None = None
    width: int | None = None
    height: int | None = None
    size: int | None = None


class CaptchaVerifyBody(BaseModel):
    id: str
    x: int


class CaptchaVerifyResult(BaseModel):
    ok: bool
    captcha_token: str


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


class HotelPatch(BaseModel):
    """编辑酒店（仅平台管理员）：局部更新 null=不改；is_active 切营业中/筹备中"""
    name: str | None = None
    city: str | None = None
    address: str | None = None
    contact_name: str | None = None
    is_active: bool | None = None


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


# ---------- 收款方式 ----------
class PayMethodBody(BaseModel):
    name: str
    remark: str = ""
    sort_order: int | None = None


class PayMethodPatch(BaseModel):
    name: str | None = None
    remark: str | None = None
    sort_order: int | None = None
    is_active: bool | None = None


class PayMethodOut(PayMethodBody):
    id: int
    code: str  # 稳定标识（payments.method 存它）；默认项 cash/wechat/alipay/card，自定义 pm_ 前缀
    sort_order: int
    is_active: bool


# ---------- room types ----------
class RoomTypeBody(BaseModel):
    name: str
    base_price: Money
    hourly_price: Money = 0  # 钟点房价（元/小时）；0 = 不支持钟点房
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
    room_number: str | None = None
    floor: int | None = None
    room_type_id: int | None = None
    notes: str | None = None


class RoomOut(BaseModel):
    id: int
    room_number: str
    floor: int
    status: str
    notes: str
    room_type_id: int
    room_type_name: str
    base_price: float


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
    rate: Money | None = None
    stay_type: Literal["normal", "hourly"] = "normal"
    hours: int = 0                    # 钟点房：入住时长（小时）
    notes: str = ""
    status: Literal["pending", "confirmed"] = "confirmed"


class ReservationPatch(BaseModel):
    """拖动换房 / 改期 / 调整预订（日期、房价）"""
    room_id: int | None = None
    check_in: date | None = None
    check_out: date | None = None
    rate: Money | None = None        # 房价单价（前端按整单总额折算）


class RegistrationBody(BaseModel):
    """在住登记信息更正（姓名 / 手机号 / 天数 / 房价 / 来源 / 备注）。

    字段为 None 表示不修改；房价或天数改动会按新口径重算首条房费账目。"""
    guest_name: str | None = None
    guest_phone: str | None = None
    nights: int | None = None         # 普通房：改入住天数（离店日 = 入住日 + 天数）
    rate: Money | None = None
    channel_id: int | None = None
    notes: str | None = None


class PaidTotalBody(BaseModel):
    """更正实收：把该预订的已收款合计调整到目标整单总额。

    amount > 当前已收 → 补一笔收款（使用 method）；amount < 当前已收 → 从最新一笔起冲减。
    """
    amount: Money
    method: str = "cash"  # 收款方式 code；写入时按本店 payment_methods 校验


class ExtendBody(BaseModel):
    """延住：普通预订按晚数延长，钟点预订按小时延长"""
    nights: int = 1
    hours: int = 0
    rate: Money | None = None         # 应收单价（默认取预订当前 rate）


class CheckInBody(BaseModel):
    room_id: int
    amount_received: Money = 0
    payment_method: str = "cash"  # 收款方式 code；写入时按本店 payment_methods 校验


class CheckOutBody(BaseModel):
    force: bool = False
    payments: list["PaymentBody"] = []


class PaymentBody(BaseModel):
    method: str  # 收款方式 code；写入时按本店 payment_methods 校验
    amount: Money
    remark: str = ""  # 收款备注（选填；＋收款弹层录入，超 120 字 400）


class FolioItemBody(BaseModel):
    category: Literal["room_charge", "other"] = "other"
    description: str
    amount: Money


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
    rate: float
    stay_type: str
    hours: int
    notes: str
    balance_due: float
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
    total_spend: float = 0
    last_stay: str | None = None


class GuestDetail(GuestOut):
    history: list[dict] = []


class GuestUpdateBody(BaseModel):
    """编辑客户档案：字段为 null 表示不改。"""
    name: str | None = None
    phone: str | None = None
    id_number: str | None = None
    notes: str | None = None


# ---------- reports ----------
class RangeQuery(BaseModel):
    from_date: date
    to_date: date


class SummaryOut(BaseModel):
    occupancy: float
    adr: float
    revpar: float
    revenue_total: float
    revenue_room: float
    revenue_other: float
    days: int
    rooms: int


class DayOut(BaseModel):
    date: date
    occupancy: float
    revenue: float
    revenue_room: float
    revenue_other: float
    arrivals: int
    departures: int
    operations: list[dict]


LoginResult.model_rebuild()
CheckOutBody.model_rebuild()
