"""云栖 PMS 后端入口"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import FRONTEND_ORIGINS
from app.db import Base, SessionLocal, engine, backfill_encrypted_fields, run_db_migrations
from app.models import Hotel
from app.routers import auth, channels, guests, hotels, reports, reservations, rooms
from app.routers import payment_methods
from app.routers.payment_methods import ensure_default_methods
from app.seed import backfill_hourly_tiers, ensure_seed


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    run_db_migrations()
    db = SessionLocal()
    try:
        backfill_encrypted_fields(db)  # 存量明文证件号 → 密文（幂等，seed 前执行）
        ensure_seed(db)
        backfill_hourly_tiers(db)  # 存量单值钟点价 → 多档位（幂等：有档位的房型跳过）
        # 存量库 / 新建店补种默认收款方式（幂等：有配置的店跳过）
        for h in db.query(Hotel).all():
            ensure_default_methods(db, h.id)
        db.commit()
    finally:
        db.close()
    yield


app = FastAPI(title="云栖 PMS", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=FRONTEND_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(hotels.router)
app.include_router(channels.router)
app.include_router(payment_methods.router)
app.include_router(rooms.router)
app.include_router(reservations.router)
app.include_router(guests.router)
app.include_router(reports.router)


@app.get("/api/health")
def health():
    return {"ok": True, "service": "yunqi-pms"}
