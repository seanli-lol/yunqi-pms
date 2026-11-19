"""冒烟测试：登录 / 建订 / 冲突 / 入住 / 清洁 / 退房全链路"""
import os
import tempfile

os.environ["YUNQI_DB"] = os.path.join(tempfile.mkdtemp(), "test-pms.db")

from fastapi.testclient import TestClient  # noqa: E402

from app.db import Base, SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.seed import ensure_seed  # noqa: E402

Base.metadata.create_all(bind=engine)
_seed_db = SessionLocal()
ensure_seed(_seed_db)
_seed_db.close()

client = TestClient(app)


def _login(username="zhouqi", hotel_id=None):
    body = {"username": username, "password": "123456"}
    if hotel_id is not None:
        body["hotel_id"] = hotel_id
    r = client.post("/api/auth/login", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _headers(token):
    return {"Authorization": f"Bearer {token}"}


def test_login_hotel_staff_and_platform_admin():
    # 员工：不选酒店应报错
    r = client.post("/api/auth/login", json={"username": "zhouqi", "password": "123456"})
    assert r.status_code == 400
    # 员工：选错酒店报错
    r = client.post("/api/auth/login", json={"username": "zhouqi", "password": "123456", "hotel_id": 999})
    assert r.status_code == 400
    # 员工：正确登录（先拿酒店 id）
    r = client.post("/api/auth/login", json={"username": "admin", "password": "123456"})
    assert r.status_code == 200
    admin = r.json()
    assert admin["user"]["role"] == "platform_admin"
    r = client.get("/api/hotels", headers=_headers(admin["token"]))
    assert r.status_code == 200
    west_lake = next(h for h in r.json() if "西湖店" in h["name"])
    data = _login("zhouqi", hotel_id=west_lake["id"])
    assert data["user"]["hotel_name"].endswith("西湖店")
    assert data["hotel_name"].endswith("西湖店")


def test_board_contains_seed_blocks():
    tok = _login("zhouqi", hotel_id=1)["token"]
    r = client.get("/api/rooms/board?days=14", headers=_headers(tok))
    assert r.status_code == 200
    data = r.json()
    assert len(data["day_list"]) == 14
    assert len(data["groups"]) >= 4
    all_blocks = [b for g in data["groups"] for rm in g["rooms"] for b in rm["blocks"]]
    assert len(all_blocks) >= 20
    li = next(b for b in all_blocks if b["guest_name"] == "李强")
    assert li["channel_name"] == "美团"
    assert li["col_start"] == 0


def test_create_direct_booking_and_conflict():
    tok = _login("zhouqi", hotel_id=1)["token"]
    h = _headers(tok)
    r = client.get("/api/rooms", headers=h)
    room_204 = next(x for x in r.json() if x["room_number"] == "204")
    from datetime import date, timedelta
    cin = (date.today() + timedelta(days=20)).isoformat()
    cout = (date.today() + timedelta(days=22)).isoformat()
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "测试客", "check_in": cin, "check_out": cout,
        "room_id": room_204["id"], "notes": "直接预订",
    })
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["room_number"] == "204"
    assert res["status"] == "confirmed"
    # 同房同时段再订 → 冲突
    r2 = client.post("/api/reservations", headers=h, json={
        "guest_name": "测试客2", "check_in": cin, "check_out": cout,
        "room_id": room_204["id"],
    })
    assert r2.status_code == 409
    # 拖动改期（改入住日 +1）
    r3 = client.patch(f"/api/reservations/{res['id']}", headers=h,
                      json={"check_in": (date.today() + timedelta(days=21)).isoformat(),
                            "check_out": (date.today() + timedelta(days=23)).isoformat()})
    assert r3.status_code == 200
    assert r3.json()["check_in"] == (date.today() + timedelta(days=21)).isoformat()


def test_checkin_checkout_flow():
    tok = _login("zhouqi", hotel_id=1)["token"]
    h = _headers(tok)
    from datetime import date, timedelta
    rooms = client.get("/api/rooms", headers=h).json()
    room_403 = next(x for x in rooms if x["room_number"] == "403")
    cin = date.today().isoformat()
    cout = (date.today() + timedelta(days=1)).isoformat()
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "入住测试客", "check_in": cin, "check_out": cout,
        "room_id": room_403["id"], "status": "confirmed",
    })
    assert r.status_code == 200
    rid = r.json()["id"]
    # 入住（403 当前是空脏 → 应被拒绝）
    r = client.post(f"/api/reservations/{rid}/check-in", headers=h,
                    json={"room_id": room_403["id"], "amount_received": 500})
    assert r.status_code == 400  # 非空净
    # 清洁任务完成 → 空净（种子中 403 为进行中任务）
    tasks = client.get("/api/housekeeping?status=in_progress", headers=h).json()
    t403 = next(t for t in tasks if t["room_number"] == "403")
    r = client.post(f"/api/housekeeping/{t403['id']}/complete", headers=h)
    assert r.status_code == 200
    # 入住成功
    r = client.post(f"/api/reservations/{rid}/check-in", headers=h,
                    json={"room_id": room_403["id"], "amount_received": 500, "payment_method": "wechat"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "checked_in"
    # 加收杂费 → 产生未结清
    r = client.post(f"/api/reservations/{rid}/folio-items", headers=h,
                    json={"category": "other", "description": "迷你吧", "amount": 58})
    assert r.status_code == 200
    # 退房：未结清 → 409；强制 → 成功且生成清洁任务
    r = client.post(f"/api/reservations/{rid}/check-out", headers=h, json={"force": False, "payments": []})
    assert r.status_code == 409
    r = client.post(f"/api/reservations/{rid}/check-out", headers=h,
                    json={"force": True, "payments": [{"method": "cash", "amount": 58}]})
    assert r.status_code == 200
    assert r.json()["status"] == "checked_out"
    tasks = client.get("/api/housekeeping?status=pending", headers=h).json()
    assert any(t["room_number"] == "403" for t in tasks)
    # 操作日志应有记录
    day = client.get(f"/api/reports/day?day={date.today().isoformat()}", headers=h).json()
    actions = [o["action"] for o in day["operations"]]
    assert "check_in" in actions and "check_out" in actions
    assert all(o["operator"] for o in day["operations"])


def test_multi_hotel_isolation():
    admin = _login("admin")
    h = _headers(admin["token"])
    hotels = client.get("/api/hotels", headers=h).json()
    west = next(x for x in hotels if "西湖店" in x["name"])
    mogan = next(x for x in hotels if "莫干山店" in x["name"])
    # 西湖店有在住，莫干山店无
    w_rooms = client.get(f"/api/rooms?hotel_id={west['id']}", headers=h).json()
    m_rooms = client.get(f"/api/rooms?hotel_id={mogan['id']}", headers=h).json()
    assert any(x["status"] == "occupied" for x in w_rooms)
    assert all(x["status"] == "vacant_clean" for x in m_rooms)
    # 员工只能看本店：周琪查询 hotel_id=莫干山 → 被忽略，返回本店数据
    tok = _login("zhouqi", hotel_id=west["id"])["token"]
    hh = _headers(tok)
    w2 = client.get(f"/api/rooms?hotel_id={mogan['id']}", headers=hh).json()
    assert any(x["status"] == "occupied" for x in w2)


def test_channel_config_and_reports():
    from datetime import date
    tok = _login("zhouqi", hotel_id=1)["token"]
    h = _headers(tok)
    chs = client.get("/api/channels", headers=h).json()
    assert len(chs) == 6
    meituan = next(c for c in chs if c["name"] == "美团")
    assert meituan["color"] == "#F7B500"
    r = client.patch(f"/api/channels/{meituan['id']}", headers=h,
                     json={"color": "#FFAA00", "sort_order": 1})
    assert r.status_code == 200
    assert r.json()["color"] == "#FFAA00"
    frm = date.today().isoformat()
    s = client.get(f"/api/reports/summary?from_date={frm}&to_date={frm}", headers=h).json()
    assert s["revenue_total"] > 0
    t = client.get(f"/api/reports/trends?from_date={frm}&to_date={frm}", headers=h).json()
    assert len(t) == 1


def test_board_direct_booking_checkin_flow():
    """回归：房态盘直接预订 → 选房接口可见锁定房 → 入住 → 退房全链路"""
    from app.routers.auth import _login_attempts
    _login_attempts.clear()  # 测试共用 client IP，避免触发每分钟 10 次的登录限流
    from datetime import date, timedelta
    tok = _login("zhouqi", hotel_id=1)["token"]
    h = _headers(tok)
    rooms = client.get("/api/rooms", headers=h).json()
    room = next(x for x in rooms if x["status"] == "vacant_clean")
    cin = date.today().isoformat()
    cout = (date.today() + timedelta(days=1)).isoformat()
    # 房态盘直接预订（锁定房号，1 晚）
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "房态盘客", "check_in": cin, "check_out": cout,
        "room_id": room["id"], "notes": "直接预订",
    })
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["room_number"] == room["room_number"]
    assert res["balance_due"] > 0  # 房费预入账，余额为正
    # 详情接口（房态盘详情弹层依赖 GET 单条）
    r = client.get(f"/api/reservations/{res['id']}", headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["code"] == res["code"]
    # 选房接口默认排除被本预订占用的房；带 exclude_res_id 后锁定房可见且只返回空净
    base = f"/api/rooms/available?room_type_id={room['room_type_id']}&check_in={cin}&check_out={cout}"
    av = client.get(base, headers=h).json()
    assert room["id"] not in {x["id"] for x in av}
    av2 = client.get(f"{base}&exclude_res_id={res['id']}", headers=h).json()
    ids2 = {x["id"] for x in av2}
    assert room["id"] in ids2
    assert all(x["status"] == "vacant_clean" for x in av2)
    # 锁定房办理入住 → 退房
    r = client.post(f"/api/reservations/{res['id']}/check-in", headers=h,
                    json={"room_id": room["id"], "amount_received": 0})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "checked_in"
    r = client.post(f"/api/reservations/{res['id']}/check-out", headers=h,
                    json={"force": False,
                          "payments": [{"method": "wechat", "amount": res["balance_due"]}]})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "checked_out"
    assert r.json()["balance_due"] == 0
