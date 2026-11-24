"""依赖项：认证、酒店上下文解析、操作日志、金额规整"""
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal

import jwt
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Hotel, OperationLog, Reservation, Room, User
from app.security import decode_token

_bearer = HTTPBearer(auto_error=False)


def bound_hotel_ids(db: Session, user: User) -> list[int]:
    """员工可访问的酒店集合：主店（users.hotel_id）+ 绑定表全部行，主店兜底在前。

    绑定表缺行（历史数据/手工 SQL）时以主店兜底，保证单店用户语义不变；
    platform_admin 不走绑定（调用方先判角色），本函数按集合语义返回。"""
    from app.models import UserHotel  # noqa: PLC0415

    ids: list[int] = []
    if user.hotel_id is not None:
        ids.append(user.hotel_id)
    bound = [r[0] for r in db.query(UserHotel.hotel_id).filter(UserHotel.user_id == user.id).all()]
    for hid in bound:
        if hid not in ids:
            ids.append(hid)
    return ids


def can_access_hotel(db: Session, user: User, hotel_id: int | None) -> bool:
    """归属守卫统一口径：platform_admin 恒真；员工 = 目标酒店在绑定集合内。

    全站详情类端点的 `user.role != "platform_admin" and X.hotel_id != user.hotel_id`
    都应替换为本谓词（多店员工切店后按当前店访问详情，不再是主店硬比较）。"""
    if user.role == "platform_admin":
        return True
    return hotel_id is not None and hotel_id in bound_hotel_ids(db, user)


def money(v) -> float:
    """金额规整到分（四舍五入 half-up）：全站金额计算/落库出口统一走此函数。

    金额列是 DECIMAL(12,2)，Python 侧按 float 运算会有二进制尾差（如 0.1+0.2），
    每次落库/比较前规整一次即可保证精确；str() 中转避免 Decimal(float) 吃进尾差。
    """
    return float(Decimal(str(v)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def fmt_money(v) -> str:
    """金额展示串（统一两位小数，无千分位）：¥ 符号由调用处拼接，如 f"¥{fmt_money(x)}"。"""
    return f"{money(v):.2f}"


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    if creds is None:
        raise HTTPException(401, "未登录")
    try:
        payload = decode_token(creds.credentials)
        user_id = int(payload.get("sub", ""))
    except (jwt.PyJWTError, KeyError, ValueError):
        raise HTTPException(401, "登录已过期，请重新登录")
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(401, "账号不存在或已停用")
    return user


def resolve_hotel_id(db: Session, user: User, hotel_id: int | None) -> int:
    """酒店上下文：员工默认主店；绑定多店的员工可显式传 hotel_id 切到绑定集合内的店；
    平台管理员必须显式指定 hotel_id（无主店可回落）"""
    if user.role == "platform_admin":
        if not hotel_id:
            raise HTTPException(400, "平台管理员需要指定 hotel_id")
        return hotel_id
    if hotel_id and hotel_id in bound_hotel_ids(db, user):
        return hotel_id  # 多店员工显式切店：仅放行绑定集合内的店
    return user.hotel_id


def require_platform_admin(user: User) -> None:
    if user.role != "platform_admin":
        raise HTTPException(403, "仅平台管理员可执行此操作")


def log_op(
    db: Session,
    hotel_id: int,
    user: User,
    action: str,
    object_type: str = "",
    object_id: int | None = None,
    summary: str = "",
) -> None:
    db.add(OperationLog(
        hotel_id=hotel_id,
        user_id=user.id,
        operator_name=user.name,
        action=action,
        object_type=object_type,
        object_id=object_id,
        summary=summary,
    ))


def balance_of(db: Session, reservation_id: int) -> float:
    """账单余额：消费合计 - 收款合计（正数表示未结清）"""
    from app.models import FolioItem, Payment

    charges = db.query(FolioItem).filter(FolioItem.reservation_id == reservation_id).all()
    pays = db.query(Payment).filter(Payment.reservation_id == reservation_id).all()
    return money(sum(x.amount for x in charges) - sum(x.amount for x in pays))


def folio_totals(db: Session, reservation_id: int) -> tuple[float, float]:
    """（应收合计, 已收合计）——房态盘退房角标明细卡分列展示金额（余额 = 应收 - 已收）"""
    from app.models import FolioItem, Payment

    charges = db.query(FolioItem).filter(FolioItem.reservation_id == reservation_id).all()
    pays = db.query(Payment).filter(Payment.reservation_id == reservation_id).all()
    return money(sum(x.amount for x in charges)), money(sum(x.amount for x in pays))


def dates_overlap(a_in: date, a_out: date, b_in: date, b_out: date) -> bool:
    """日期区间是否重叠（半开区间：退房当天可再入住）"""
    return a_in < b_out and b_in < a_out


def blocking_ids(db: Session, hotel_id: int, room_id: int, cin: date, cout: date,
                 exclude: int | None = None, include_checked_in: bool = True) -> set[int]:
    """该房在时段内被哪些预订占用（pending/confirmed，默认含 checked_in）。

    include_checked_in=False：办理入住用——前客未退也允许入住（业务放宽），
    只按未到店预订计冲突。"""
    statuses = ["pending", "confirmed"] + (["checked_in"] if include_checked_in else [])
    res = db.query(Reservation).filter(
        Reservation.hotel_id == hotel_id,
        Reservation.room_id == room_id,
        Reservation.status.in_(statuses),
        Reservation.check_in < cout,
        Reservation.check_out > cin,
    ).all()
    return {r.id for r in res if r.id != exclude}


def free_rooms(db: Session, hotel_id: int, type_id: int, cin: date, cout: date,
               exclude_res_id: int | None = None, only_clean: bool = False,
               include_checked_in: bool = True) -> list[Room]:
    """时段内该房型未被占用的客房；only_clean=True 时仅空净（入住选房用）。

    include_checked_in=False：冲突判断不含在住预订（配合前客未退入住的放宽）。
    空脏房入选由调用方 only_clean=False 控制（维修房始终排除）。"""
    qy = db.query(Room).filter(
        Room.hotel_id == hotel_id,
        Room.room_type_id == type_id,
        Room.status != "maintenance",
    )
    if only_clean:
        qy = qy.filter(Room.status == "vacant_clean")
    rooms = qy.all()
    statuses = ["pending", "confirmed"] + (["checked_in"] if include_checked_in else [])
    res = db.query(Reservation).filter(
        Reservation.hotel_id == hotel_id,
        Reservation.room_id.isnot(None),
        Reservation.status.in_(statuses),
        Reservation.check_in < cout,
        Reservation.check_out > cin,
    ).all()
    # exclude_res_id：办理入住查询时排除本预订自身（否则锁定的房会被自己挡住）
    blocked = {r.room_id for r in res if r.id != exclude_res_id}
    return [r for r in rooms if r.id not in blocked]
