"""云栖 PMS 后端入口"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import FRONTEND_ORIGINS
from app.db import Base, SessionLocal, engine
from app.routers import auth, channels, guests, hotels, housekeeping, reports, reservations, rooms
from app.seed import ensure_seed


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        ensure_seed(db)
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
app.include_router(rooms.router)
app.include_router(reservations.router)
app.include_router(guests.router)
app.include_router(housekeeping.router)
app.include_router(reports.router)


@app.get("/api/health")
def health():
    return {"ok": True, "service": "yunqi-pms"}
