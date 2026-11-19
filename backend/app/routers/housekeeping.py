"""客房清洁任务：创建 / 开始 / 完成（完成自动转空净）"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_current_user, log_op, resolve_hotel_id
from app.models import HousekeepingTask, Room, RoomType, User
from app.schemas import TaskBody, TaskOut

router = APIRouter(prefix="/api/housekeeping", tags=["housekeeping"])

TYPE_LABELS = {"checkout": "退房清洁", "daily": "日常清扫", "deep": "深度清洁",
               "repair": "维修", "inspection": "检查"}


def task_out(db: Session, t: HousekeepingTask) -> TaskOut:
    room = db.get(Room, t.room_id)
    rt = db.get(RoomType, room.room_type_id) if room else None
    return TaskOut(
        id=t.id, room_id=t.room_id,
        room_number=room.room_number if room else "",
        room_type_name=rt.name if rt else "",
        floor=room.floor if room else 0,
        task_type=t.task_type, status=t.status, priority=t.priority,
        assignee=t.assignee, notes=t.notes,
        created_at=t.created_at, completed_at=t.completed_at,
    )


@router.get("")
def list_tasks(status: str | None = None, hotel_id: int | None = None,
               user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    hid = resolve_hotel_id(user, hotel_id)
    q = db.query(HousekeepingTask).filter(HousekeepingTask.hotel_id == hid)
    if status and status != "all":
        q = q.filter(HousekeepingTask.status == status)
    tasks = q.order_by(HousekeepingTask.created_at.desc()).all()
    return [task_out(db, t) for t in tasks]


@router.post("")
def create_task(body: TaskBody, hotel_id: int | None = None,
                user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    hid = resolve_hotel_id(user, hotel_id)
    room = db.get(Room, body.room_id)
    if not room or room.hotel_id != hid:
        raise HTTPException(400, "客房不存在")
    t = HousekeepingTask(hotel_id=hid, room_id=room.id, task_type=body.task_type,
                         status="pending", priority=body.priority,
                         assignee=body.assignee, notes=body.notes, created_by=user.id)
    db.add(t)
    # 生成任务后房间标记为空脏（待清洁）
    if room.status == "vacant_clean":
        room.status = "vacant_dirty"
    db.flush()
    log_op(db, hid, user, "housekeeping_create", "task", t.id,
           f"创建清洁任务 {room.room_number}（{TYPE_LABELS[body.task_type]}）")
    db.commit()
    return task_out(db, t)


@router.post("/{task_id}/start")
def start_task(task_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    t = db.get(HousekeepingTask, task_id)
    if not t or (user.role != "platform_admin" and t.hotel_id != user.hotel_id):
        raise HTTPException(404, "任务不存在")
    if t.status != "pending":
        raise HTTPException(400, "仅待清洁任务可开始")
    t.status = "in_progress"
    room = db.get(Room, t.room_id)
    log_op(db, t.hotel_id, user, "housekeeping_start", "task", t.id,
           f"开始清洁 {room.room_number if room else ''}")
    db.commit()
    return task_out(db, t)


@router.post("/{task_id}/complete")
def complete_task(task_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    t = db.get(HousekeepingTask, task_id)
    if not t or (user.role != "platform_admin" and t.hotel_id != user.hotel_id):
        raise HTTPException(404, "任务不存在")
    if t.status == "done":
        raise HTTPException(400, "任务已完成")
    t.status = "done"
    t.completed_at = datetime.now()
    room = db.get(Room, t.room_id)
    if room:
        if room.status != "occupied":
            room.status = "vacant_clean"
    log_op(db, t.hotel_id, user, "housekeeping_done", "task", t.id,
           f"清洁完成 {room.room_number if room else ''} · 房态转为空净")
    db.commit()
    return task_out(db, t)
