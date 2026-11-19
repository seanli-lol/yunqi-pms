"""冒烟测试：登录 / 建订 / 冲突 / 入住 / 退房 / 设净全链路"""
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
    assert room_403["status"] == "vacant_dirty"
    cin = date.today().isoformat()
    cout = (date.today() + timedelta(days=1)).isoformat()
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "入住测试客", "check_in": cin, "check_out": cout,
        "room_id": room_403["id"], "status": "confirmed",
    })
    assert r.status_code == 200
    rid = r.json()["id"]
    # 业务放宽：脏房可直接入住（不再强制空净）
    r = client.post(f"/api/reservations/{rid}/check-in", headers=h,
                    json={"room_id": room_403["id"], "amount_received": 500, "payment_method": "wechat"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "checked_in"
    # 加收杂费 → 产生未结清
    r = client.post(f"/api/reservations/{rid}/folio-items", headers=h,
                    json={"category": "other", "description": "迷你吧", "amount": 58})
    assert r.status_code == 200
    # 退房：未结清 → 409；强制 → 成功且房态转空脏
    r = client.post(f"/api/reservations/{rid}/check-out", headers=h, json={"force": False, "payments": []})
    assert r.status_code == 409
    r = client.post(f"/api/reservations/{rid}/check-out", headers=h,
                    json={"force": True, "payments": [{"method": "cash", "amount": 58}]})
    assert r.status_code == 200
    assert r.json()["status"] == "checked_out"
    rooms = client.get("/api/rooms", headers=h).json()
    assert next(x for x in rooms if x["room_number"] == "403")["status"] == "vacant_dirty"
    # 详情接口带出房态（前端据此显示「转为净房」）
    detail = client.get(f"/api/reservations/{rid}", headers=h).json()
    assert detail["room_status"] == "vacant_dirty"
    # 日历一键设净：房态转空净
    r = client.patch(f"/api/rooms/{room_403['id']}", headers=h, json={"status": "vacant_clean"})
    assert r.status_code == 200
    rooms = client.get("/api/rooms", headers=h).json()
    assert next(x for x in rooms if x["room_number"] == "403")["status"] == "vacant_clean"
    # 已退房预订的房态同步为净房（「转为净房」按钮随之隐藏）
    detail = client.get(f"/api/reservations/{rid}", headers=h).json()
    assert detail["room_status"] == "vacant_clean"
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
    # 放宽参数：include_dirty 带入空脏房（如 303）；预离店（check_out=今天）的占房也会出现
    av3 = client.get(f"{base}&exclude_res_id={res['id']}&include_dirty=1", headers=h).json()
    assert {x["id"] for x in av3} >= ids2
    assert any(x["status"] == "vacant_dirty" for x in av3)
    assert all(x["status"] in ("vacant_clean", "vacant_dirty", "occupied") for x in av3)
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


def test_hourly_booking_flow():
    """钟点房全链路：建单→账目→详情→入住→退房；冲突与校验"""
    from datetime import date, timedelta
    tok = _login("zhouqi", hotel_id=1)["token"]
    h = _headers(tok)
    rooms = client.get("/api/rooms", headers=h).json()
    # 选观景大床房（钟点需手动传价），避开前面测试用掉的大床房空净房
    room = next(x for x in rooms if x["room_type_name"] == "观景大床房" and x["status"] == "vacant_clean")
    cin = (date.today() + timedelta(days=30)).isoformat()
    # 时长越界
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "钟点客", "check_in": cin, "check_out": (date.today() + timedelta(days=31)).isoformat(),
        "room_id": room["id"], "stay_type": "hourly", "hours": 20,
    })
    assert r.status_code == 400
    # 正常创建：手动传钟点价 45
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "钟点客", "check_in": cin, "check_out": (date.today() + timedelta(days=31)).isoformat(),
        "room_id": room["id"], "stay_type": "hourly", "hours": 4, "status": "confirmed", "rate": 45,
    })
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["stay_type"] == "hourly" and res["hours"] == 4
    assert res["rate"] == 45
    assert res["nights"] == 1
    # 同房同时段再订 → 冲突（钟点占整日）
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "钟点客2", "check_in": cin, "check_out": (date.today() + timedelta(days=31)).isoformat(),
        "room_id": room["id"],
    })
    assert r.status_code == 409
    # 钟点房不可拖动改期
    r = client.patch(f"/api/reservations/{res['id']}", headers=h,
                     json={"check_in": (date.today() + timedelta(days=31)).isoformat(),
                           "check_out": (date.today() + timedelta(days=32)).isoformat()})
    assert r.status_code == 400
    # 账目：钟点房费 4 × 45 = 180
    folio = client.get(f"/api/reservations/{res['id']}/folio", headers=h).json()
    assert folio["items"][0]["description"] == "钟点房费 · 4 小时 × ¥45"
    assert folio["total_charge"] == 180
    # 入住 → 退房
    r = client.post(f"/api/reservations/{res['id']}/check-in", headers=h,
                    json={"room_id": room["id"], "amount_received": 180, "payment_method": "cash"})
    assert r.status_code == 200, r.text
    r = client.post(f"/api/reservations/{res['id']}/check-out", headers=h,
                    json={"force": False, "payments": []})
    assert r.status_code == 200, r.text
    assert r.json()["balance_due"] == 0
    # 未配钟点价的房型（房型未传价）→ 400（亲子房无钟点价）
    room2 = next(x for x in rooms if x["room_type_name"] == "亲子房" and x["status"] == "vacant_clean")
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "钟点客3", "check_in": cin, "check_out": (date.today() + timedelta(days=31)).isoformat(),
        "room_id": room2["id"], "stay_type": "hourly", "hours": 3,
    })
    assert r.status_code == 400
    # 大床房空净房按房型自动取钟点价 45（前面直接预订测试后应有空净房可用）
    big_clean = next(x for x in rooms if x["room_type_name"] == "大床房" and x["status"] == "vacant_clean")
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "钟点客4", "check_in": cin, "check_out": (date.today() + timedelta(days=31)).isoformat(),
        "room_id": big_clean["id"], "stay_type": "hourly", "hours": 3,
    })
    assert r.status_code == 200, r.text
    assert r.json()["rate"] == 45
    # 房态盘 block 输出 stay_type/hours
    board = client.get("/api/rooms/board?days=45", headers=h).json()
    blk = next(b for g in board["groups"] for rm in g["rooms"] for b in rm["blocks"] if b["id"] == res["id"])
    assert blk["stay_type"] == "hourly" and blk["hours"] == 4


def test_extend_reservation():
    """延住：自定义天数+价格→增量账目；冲突 409；日志；钟点按小时延"""
    from app.routers.auth import _login_attempts
    _login_attempts.clear()
    from datetime import date, timedelta
    tok = _login("zhouqi", hotel_id=1)["token"]
    h = _headers(tok)
    rooms = client.get("/api/rooms", headers=h).json()
    room = next(x for x in rooms if x["room_type_name"] == "大床房" and x["status"] == "vacant_clean")
    cin = date.today().isoformat()
    cout = (date.today() + timedelta(days=2)).isoformat()
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "延住客", "check_in": cin, "check_out": cout,
        "room_id": room["id"], "status": "confirmed", "rate": 400,
    })
    assert r.status_code == 200, r.text
    res = r.json()
    rid = res["id"]
    r = client.post(f"/api/reservations/{rid}/check-in", headers=h,
                    json={"room_id": room["id"], "amount_received": 800})
    assert r.status_code == 200, r.text
    # 住期 [今天, +2)：挡路客订 [+4, +6)（与当前住期不重叠，可建单）
    r2 = client.post("/api/reservations", headers=h, json={
        "guest_name": "挡路客", "check_in": (date.today() + timedelta(days=4)).isoformat(),
        "check_out": (date.today() + timedelta(days=6)).isoformat(),
        "room_id": room["id"], "status": "confirmed",
    })
    assert r2.status_code == 200, r2.text
    # 延住 2 晚 × ¥450（自定义价）→ 新离店 +4，不与挡路客冲突
    r = client.post(f"/api/reservations/{rid}/extend", headers=h,
                    json={"nights": 2, "rate": 450})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["check_out"] == (date.today() + timedelta(days=4)).isoformat()
    folio = client.get(f"/api/reservations/{rid}/folio", headers=h).json()
    ext = [x for x in folio["items"] if "延住" in x["description"]]
    assert len(ext) == 1
    assert ext[0]["amount"] == 900
    assert folio["total_charge"] == 800 + 900  # 原房费不动，追加增量
    # 再延 1 晚 → 撞上挡路客 [+4, +6) → 409
    r = client.post(f"/api/reservations/{rid}/extend", headers=h,
                    json={"nights": 1, "rate": 450})
    assert r.status_code == 409
    # 日志：reservation_extend 已落
    logs = client.get(f"/api/reservations/{rid}/logs", headers=h).json()
    actions = [o["action"] for o in logs]
    assert "reservation_extend" in actions
    assert "reservation_create" in actions and "check_in" in actions
    assert all(o["operator"] for o in logs)
    # 钟点房按小时延住
    hroom = next(x for x in rooms if x["room_type_name"] == "双床房" and x["status"] == "vacant_clean")
    hcin = (date.today() + timedelta(days=40)).isoformat()
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "钟点延客", "check_in": hcin, "check_out": (date.today() + timedelta(days=41)).isoformat(),
        "room_id": hroom["id"], "stay_type": "hourly", "hours": 2, "status": "confirmed",
    })
    assert r.status_code == 200, r.text
    hres = r.json()
    r = client.post(f"/api/reservations/{hres['id']}/check-in", headers=h,
                    json={"room_id": hroom["id"], "amount_received": 0})
    assert r.status_code == 200, r.text
    r = client.post(f"/api/reservations/{hres['id']}/extend", headers=h,
                    json={"hours": 2, "rate": 55})
    assert r.status_code == 200, r.text
    assert r.json()["hours"] == 4
    assert r.json()["check_out"] == hres["check_out"]  # 离店日不变
    folio = client.get(f"/api/reservations/{hres['id']}/folio", headers=h).json()
    ext = [x for x in folio["items"] if "延住" in x["description"]]
    assert ext and ext[0]["amount"] == 110  # 2 小时 × 55
    # 在住预订退房后不可再延
    r = client.post(f"/api/reservations/{rid}/check-out", headers=h,
                    json={"force": True, "payments": []})
    assert r.status_code == 200
    r = client.post(f"/api/reservations/{rid}/extend", headers=h, json={"nights": 1})
    assert r.status_code == 400


def test_reservation_logs_endpoint():
    """预订日志端点：按预订聚合操作留痕，含收款类"""
    from datetime import date, timedelta
    tok = _login("zhouqi", hotel_id=1)["token"]
    h = _headers(tok)
    rooms = client.get("/api/rooms", headers=h).json()
    room = next(x for x in rooms if x["status"] == "vacant_clean")
    cin = (date.today() + timedelta(days=50)).isoformat()
    cout = (date.today() + timedelta(days=51)).isoformat()
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "日志客", "check_in": cin, "check_out": cout,
        "room_id": room["id"], "status": "confirmed",
    })
    assert r.status_code == 200, r.text
    rid = r.json()["id"]
    # 产生一条收款日志
    r = client.post(f"/api/reservations/{rid}/payments", headers=h,
                    json={"method": "wechat", "amount": 100})
    assert r.status_code == 200
    r = client.get(f"/api/reservations/{rid}/logs", headers=h)
    assert r.status_code == 200
    logs = r.json()
    actions = [o["action"] for o in logs]
    assert "reservation_create" in actions and "payment" in actions
    assert all(set(o) >= {"time", "action", "summary", "operator"} for o in logs)
    # 倒序：最新在前
    assert logs[0]["action"] == "payment"
    # 他人酒店不可见
    r = client.get(f"/api/reservations/{rid}/logs", headers=_headers(_login("admin")["token"]))
    assert r.status_code == 200  # 平台管理员可查
