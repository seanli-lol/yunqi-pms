"""收款方式：名称 / 说明 / 顺序可配置，各店独立。

payments.method 存稳定 code：默认项 cash/wechat/alipay/card 与存量数据天然对齐，
自定义项生成 pm_ 前缀随机 code。有收款记录的方式只停用不删除（同渠道规则）。
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_current_user, log_op, resolve_hotel_id
from app.models import Payment, PayMethod, User
from app.schemas import PayMethodBody, PayMethodOut, PayMethodPatch

router = APIRouter(prefix="/api/payment-methods", tags=["payment-methods"])

# 默认收款方式：(code, 名称, 说明)——code 与存量 payments.method 的历史取值对齐
DEFAULT_METHODS = [
    ("cash", "现金", "到店现金支付"),
    ("wechat", "微信", "微信扫码 / 小程序支付"),
    ("alipay", "支付宝", "支付宝扫码"),
    ("card", "刷卡", "银联银行卡 / 信用卡"),
]
# 无配置时的兜底名称映射（code 被物理删除后，历史日志仍可读）
METHOD_FALLBACK = dict(cash="现金", wechat="微信", alipay="支付宝", card="刷卡")


def ensure_default_methods(db: Session, hotel_id: int) -> None:
    """该店尚无收款方式配置时补种默认 4 项（幂等；启动与新建酒店时调用）"""
    if db.query(PayMethod).filter(PayMethod.hotel_id == hotel_id).first():
        return
    for sort, (code, name, remark) in enumerate(DEFAULT_METHODS, 1):
        db.add(PayMethod(hotel_id=hotel_id, code=code, name=name, remark=remark, sort_order=sort))
    db.flush()


def pay_method_label(db: Session, hotel_id: int, code: str) -> str:
    """日志展示名：优先取配置名（改名后新日志用新名），无配置的 code 走内置兜底映射"""
    m = db.query(PayMethod).filter(PayMethod.hotel_id == hotel_id, PayMethod.code == code).first()
    if m:
        return m.name
    return METHOD_FALLBACK.get(code, code)


def assert_method_usable(db: Session, hotel_id: int, code: str) -> None:
    """收款写入校验：方式必须属于本店且处于启用状态"""
    m = db.query(PayMethod).filter(PayMethod.hotel_id == hotel_id, PayMethod.code == code).first()
    if not m:
        raise HTTPException(400, "收款方式不存在，请先在「设置 · 收款方式」中配置")
    if not m.is_active:
        raise HTTPException(400, f"收款方式「{m.name}」已停用，请换用其他方式或先启用")


@router.get("", response_model=list[PayMethodOut])
def list_pay_methods(
    hotel_id: int | None = None,
    include_inactive: bool = False,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    hid = resolve_hotel_id(user, hotel_id)
    q = db.query(PayMethod).filter(PayMethod.hotel_id == hid)
    if not include_inactive:
        q = q.filter(PayMethod.is_active)
    return q.order_by(PayMethod.sort_order, PayMethod.id).all()


@router.post("", response_model=PayMethodOut)
def create_pay_method(body: PayMethodBody, hotel_id: int | None = None,
                      user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    hid = resolve_hotel_id(user, hotel_id)
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "请输入收款方式名称")
    dup = db.query(PayMethod).filter(PayMethod.hotel_id == hid, PayMethod.name == name).first()
    if dup:
        raise HTTPException(400, f"收款方式「{name}」已存在")
    sort = body.sort_order
    if sort is None:
        sort = db.query(PayMethod).filter(PayMethod.hotel_id == hid).count() + 1
    m = PayMethod(hotel_id=hid, code=f"pm_{uuid.uuid4().hex[:8]}", name=name,
                  remark=body.remark.strip(), sort_order=sort)
    db.add(m)
    db.flush()
    log_op(db, hid, user, "paymethod_create", "payment_method", m.id, f"新增收款方式「{m.name}」")
    db.commit()
    return PayMethodOut(id=m.id, code=m.code, name=m.name, remark=m.remark,
                        sort_order=m.sort_order, is_active=m.is_active)


@router.patch("/{method_id}", response_model=PayMethodOut)
def patch_pay_method(method_id: int, body: PayMethodPatch,
                     user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    m = db.get(PayMethod, method_id)
    if not m or (user.role != "platform_admin" and m.hotel_id != user.hotel_id):
        raise HTTPException(404, "收款方式不存在")
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(400, "请输入收款方式名称")
        dup = db.query(PayMethod).filter(
            PayMethod.hotel_id == m.hotel_id, PayMethod.name == name, PayMethod.id != m.id).first()
        if dup:
            raise HTTPException(400, f"收款方式「{name}」已存在")
        m.name = name
    if body.remark is not None:
        m.remark = body.remark.strip()
    if body.sort_order is not None:
        m.sort_order = body.sort_order
    if body.is_active is not None:
        m.is_active = body.is_active
    log_op(db, m.hotel_id, user, "paymethod_update", "payment_method", m.id,
           f"更新收款方式「{m.name}」" + ("" if m.is_active else "（已停用）"))
    db.commit()
    return PayMethodOut(id=m.id, code=m.code, name=m.name, remark=m.remark,
                        sort_order=m.sort_order, is_active=m.is_active)


@router.delete("/{method_id}")
def delete_pay_method(method_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """有收款记录的方式不可物理删除：改为停用"""
    m = db.get(PayMethod, method_id)
    if not m or (user.role != "platform_admin" and m.hotel_id != user.hotel_id):
        raise HTTPException(404, "收款方式不存在")
    # 判定依据：该方式名下（同店）是否有历史收款
    used = db.query(Payment).filter(
        Payment.hotel_id == m.hotel_id,
        Payment.method == m.code,
    ).count()
    if used:
        m.is_active = False
        log_op(db, m.hotel_id, user, "paymethod_disable", "payment_method", m.id,
               f"停用收款方式「{m.name}」（有 {used} 笔收款记录）")
        db.commit()
        return {"ok": True, "disabled": True}
    log_op(db, m.hotel_id, user, "paymethod_delete", "payment_method", m.id, f"删除收款方式「{m.name}」")
    db.delete(m)
    db.commit()
    return {"ok": True}
