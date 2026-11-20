"""冒烟测试：登录 / 建订 / 冲突 / 入住 / 退房 / 设净全链路"""
import os
import tempfile

os.environ["YUNQI_DB"] = os.path.join(tempfile.mkdtemp(), "test-pms.db")
# 冒烟测试默认不要求滑块验证码（验证码专项用例里用 captcha.set_enabled 单独开关）
os.environ["YUNQI_CAPTCHA"] = "off"

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
    types = {t["name"]: t for t in client.get("/api/room-types", headers=h).json()}
    rooms = client.get("/api/rooms", headers=h).json()
    # 入住要过「入住日当天」门槛：钟点房用今天，从可售接口挑空房（放宽到脏房/前客未退）
    cin = date.today().isoformat()
    cout = (date.today() + timedelta(days=1)).isoformat()

    def pick(type_name):
        t = types[type_name]
        av = client.get(
            f"/api/rooms/available?room_type_id={t['id']}&check_in={cin}&check_out={cout}"
            f"&include_dirty=1&allow_prev_guest=1", headers=h).json()
        # 优先空房（在住占用房在 create 时会撞 checked_in 冲突）
        idle = [x for x in av if x["status"] in ("vacant_clean", "vacant_dirty")]
        assert idle, f"{type_name} 无可用空房"
        return idle[0]

    room = pick("观景大床房")  # 钟点需手动传价，避开前面测试用掉的大床房空净房
    # 时长越界
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "钟点客", "check_in": cin, "check_out": cout,
        "room_id": room["id"], "stay_type": "hourly", "hours": 20,
    })
    assert r.status_code == 400
    # 正常创建：手动传钟点价 45
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "钟点客", "check_in": cin, "check_out": cout,
        "room_id": room["id"], "stay_type": "hourly", "hours": 4, "status": "confirmed", "rate": 45,
    })
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["stay_type"] == "hourly" and res["hours"] == 4
    assert res["rate"] == 45
    assert res["nights"] == 1
    # 同房同时段再订 → 冲突（钟点占整日）
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "钟点客2", "check_in": cin, "check_out": cout,
        "room_id": room["id"],
    })
    assert r.status_code == 409
    # 钟点房不可拖动改期
    r = client.patch(f"/api/reservations/{res['id']}", headers=h,
                     json={"check_in": (date.today() + timedelta(days=1)).isoformat(),
                           "check_out": (date.today() + timedelta(days=2)).isoformat()})
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
    room2 = pick("亲子房")
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "钟点客3", "check_in": cin, "check_out": cout,
        "room_id": room2["id"], "stay_type": "hourly", "hours": 3,
    })
    assert r.status_code == 400
    # 大床房空净房按房型自动取钟点价 45
    big = pick("大床房")
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "钟点客4", "check_in": cin, "check_out": cout,
        "room_id": big["id"], "stay_type": "hourly", "hours": 3,
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
    # 钟点房按小时延住（入住要过「入住日当天」门槛，用今天）
    hcin = date.today().isoformat()
    hcout = (date.today() + timedelta(days=1)).isoformat()
    ht = {t["name"]: t for t in client.get("/api/room-types", headers=h).json()}["双床房"]
    hav = client.get(
        f"/api/rooms/available?room_type_id={ht['id']}&check_in={hcin}&check_out={hcout}"
        f"&include_dirty=1&allow_prev_guest=1", headers=h).json()
    idle_h = [x for x in hav if x["status"] in ("vacant_clean", "vacant_dirty")]
    assert idle_h, "双床房无可用空房"
    hroom = idle_h[0]
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "钟点延客", "check_in": hcin, "check_out": hcout,
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


def test_edit_registration_and_undo_check_in():
    """在住登记信息更正（含改天数）+ 撤销入住（保留收款）+ 取消预订（清除收款）"""
    from app.routers.auth import _login_attempts
    _login_attempts.clear()
    from datetime import date, timedelta
    tok = _login("zhouqi", hotel_id=1)["token"]
    h = _headers(tok)
    cin = date.today().isoformat()
    cout = (date.today() + timedelta(days=2)).isoformat()
    # 用「当前可售且本身无在住客人」的房：撤销入住后房态才能干净地回到空脏
    all_rooms = client.get("/api/rooms", headers=h).json()
    idle_ids = {x["id"] for x in all_rooms if x["status"] in ("vacant_clean", "vacant_dirty")}
    avail = client.get(
        f"/api/rooms/available?room_type_id=1&check_in={cin}&check_out={cout}&include_dirty=1",
        headers=h).json()
    room = next(x for x in avail if x["id"] in idle_ids)
    ch = client.get("/api/channels", headers=h).json()[0]
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "登记原名", "guest_phone": "13900001111",
        "check_in": cin, "check_out": cout, "room_id": room["id"], "room_type_id": room.get("room_type_id", 1),
    })
    assert r.status_code == 200, r.text
    res = r.json()
    rid = res["id"]
    fee_before = res["balance_due"]
    assert fee_before == 2 * res["rate"]  # 2 晚房费

    # 未来入住日的预订：只能保持预订，不可办理入住 / 退房
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "未来客", "check_in": (date.today() + timedelta(days=60)).isoformat(),
        "check_out": (date.today() + timedelta(days=62)).isoformat(),
        "room_id": room["id"],
    })
    assert r.status_code in (200, 409), r.text
    if r.status_code == 200:
        future = r.json()
        r = client.post(f"/api/reservations/{future['id']}/check-in", headers=h,
                        json={"room_id": room["id"]})
        assert r.status_code == 400
        assert "只能预订" in r.json()["detail"]
        r = client.post(f"/api/reservations/{future['id']}/check-out", headers=h, json={"force": True})
        assert r.status_code == 400
        r = client.post(f"/api/reservations/{future['id']}/cancel", headers=h)
        assert r.status_code == 200

    # 未入住 → 不可编辑登记 / 不可撤销
    r = client.patch(f"/api/reservations/{rid}/registration", headers=h, json={"guest_name": "改名"})
    assert r.status_code == 400
    r = client.post(f"/api/reservations/{rid}/undo-check-in", headers=h)
    assert r.status_code == 400

    # 入住并收取部分款项
    paid = 100
    r = client.post(f"/api/reservations/{rid}/check-in", headers=h,
                    json={"room_id": room["id"], "amount_received": paid, "payment_method": "cash"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "checked_in"

    # ---- 编辑登记：姓名 / 手机号 / 房价 / 来源 / 备注 ----
    new_rate = res["rate"] + 20
    r = client.patch(f"/api/reservations/{rid}/registration", headers=h, json={
        "guest_name": "登记改名", "guest_phone": "13900002222",
        "rate": new_rate, "channel_id": ch["id"], "notes": "改到高楼层",
    })
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["guest_name"] == "登记改名"
    assert out["guest_phone"] == "13900002222"
    assert out["rate"] == new_rate
    assert out["channel_id"] == ch["id"]
    assert out["notes"] == "改到高楼层"
    # 房费账目按新单价重算：2 晚 × 新价，且只重算首条房费行
    folio = client.get(f"/api/reservations/{rid}/folio", headers=h).json()
    room_rows = [x for x in folio["items"] if x["category"] == "room_charge"]
    assert len(room_rows) == 1
    assert room_rows[0]["amount"] == 2 * new_rate
    assert folio["total_charge"] == 2 * new_rate
    assert folio["balance_due"] == 2 * new_rate - paid

    # ---- 编辑登记：改入住天数 → 离店日与首条房费同步重算 ----
    r = client.patch(f"/api/reservations/{rid}/registration", headers=h, json={"nights": 3})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["nights"] == 3
    assert out["check_out"] == (date.today() + timedelta(days=3)).isoformat()
    folio = client.get(f"/api/reservations/{rid}/folio", headers=h).json()
    room_rows = [x for x in folio["items"] if x["category"] == "room_charge"]
    assert len(room_rows) == 1
    assert room_rows[0]["amount"] == 3 * new_rate
    assert folio["total_charge"] == 3 * new_rate
    # 天数非法
    r = client.patch(f"/api/reservations/{rid}/registration", headers=h, json={"nights": 0})
    assert r.status_code == 400

    # 姓名为空 → 400；房价为负 → 400
    r = client.patch(f"/api/reservations/{rid}/registration", headers=h, json={"guest_name": "  "})
    assert r.status_code == 400
    r = client.patch(f"/api/reservations/{rid}/registration", headers=h, json={"rate": -1})
    assert r.status_code == 400

    # ---- 更正实收：调整到 500（补收），再冲减到 200 ----
    r = client.patch(f"/api/reservations/{rid}/paid-total", headers=h,
                     json={"amount": 500, "method": "wechat"})
    assert r.status_code == 200, r.text
    folio = client.get(f"/api/reservations/{rid}/folio", headers=h).json()
    assert folio["total_paid"] == 500
    assert sum(p["amount"] for p in folio["payments"]) == 500
    r = client.patch(f"/api/reservations/{rid}/paid-total", headers=h, json={"amount": 200})
    assert r.status_code == 200, r.text
    folio = client.get(f"/api/reservations/{rid}/folio", headers=h).json()
    assert folio["total_paid"] == 200
    assert sum(p["amount"] for p in folio["payments"]) == 200
    assert folio["balance_due"] == 3 * new_rate - 200
    # 实收为负 → 400
    r = client.patch(f"/api/reservations/{rid}/paid-total", headers=h, json={"amount": -5})
    assert r.status_code == 400

    # ---- 撤销入住：退回已确认，收款保留 ----
    room_before = next(x for x in client.get("/api/rooms", headers=h).json() if x["id"] == room["id"])
    r = client.post(f"/api/reservations/{rid}/undo-check-in", headers=h)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["status"] == "confirmed"
    assert out["room_id"] == room["id"]  # 原锁定房号保留
    folio = client.get(f"/api/reservations/{rid}/folio", headers=h).json()
    assert folio["total_paid"] == 200  # 撤销入住不再清除收款
    assert folio["balance_due"] == 3 * new_rate - 200
    # 房态退回空脏
    room_after = next(x for x in client.get("/api/rooms", headers=h).json() if x["id"] == room["id"])
    assert room_after["status"] == "vacant_dirty"
    # 撤销后不可再次撤销；可重新办理入住
    r = client.post(f"/api/reservations/{rid}/undo-check-in", headers=h)
    assert r.status_code == 400
    r = client.post(f"/api/reservations/{rid}/check-in", headers=h,
                    json={"room_id": room["id"], "amount_received": 0})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "checked_in"
    # 操作日志留痕：编辑 / 撤销
    logs = client.get(f"/api/reservations/{rid}/logs", headers=h).json()
    actions = [o["action"] for o in logs]
    assert "reservation_edit" in actions
    assert "check_in_undo" in actions
    assert "payment_adjust" in actions

    # ---- 已退房 → 撤销退房回到在住；收款保留；退房→撤销链完整 ----
    r = client.post(f"/api/reservations/{rid}/check-out", headers=h,
                    json={"force": True, "payments": []})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "checked_out"
    paid_before_undo = client.get(f"/api/reservations/{rid}/folio", headers=h).json()["total_paid"]
    r = client.post(f"/api/reservations/{rid}/undo-check-out", headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "checked_in"
    assert r.json()["check_out"] != cin  # 日期不变（3 晚）
    folio = client.get(f"/api/reservations/{rid}/folio", headers=h).json()
    assert folio["total_paid"] == paid_before_undo  # 撤销退房不退款
    room_now = next(x for x in client.get("/api/rooms", headers=h).json() if x["id"] == room["id"])
    assert room_now["status"] == "occupied"
    assert "check_out_undo" in [o["action"] for o in client.get(f"/api/reservations/{rid}/logs", headers=h).json()]
    # 已退房状态才可撤销退房
    r = client.post(f"/api/reservations/{rid}/undo-check-out", headers=h)
    assert r.status_code == 400

    # ---- 取消预订：唯一清除已收款的环节 ----
    r = client.post(f"/api/reservations/{rid}/undo-check-in", headers=h)
    assert r.status_code == 200, r.text
    assert client.get(f"/api/reservations/{rid}/folio", headers=h).json()["total_paid"] == paid_before_undo
    r = client.post(f"/api/reservations/{rid}/cancel", headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "cancelled"
    folio = client.get(f"/api/reservations/{rid}/folio", headers=h).json()
    assert folio["payments"] == []
    assert folio["total_paid"] == 0
    assert folio["balance_due"] == 3 * new_rate
    logs = client.get(f"/api/reservations/{rid}/logs", headers=h).json()
    assert "reservation_cancel" in [o["action"] for o in logs]
    assert any("清除已收款" in o["summary"] for o in logs)


def test_early_checkout_resale():
    """回归：提前退房（actual_check_out 早于 check_out）→ 房态盘灰块截断 + 尾段可再售 + 撤销退房恢复"""
    tok = _login("zhouqi", hotel_id=1)["token"]
    h = _headers(tok)
    from datetime import date, timedelta
    rooms = client.get("/api/rooms", headers=h).json()
    room = next(x for x in rooms if x["room_number"] == "503")
    cin = (date.today() - timedelta(days=1)).isoformat()
    cout = (date.today() + timedelta(days=2)).isoformat()  # 原订 3 晚，今天尚未到期
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "提前退房客", "check_in": cin, "check_out": cout,
        "room_id": room["id"],
    })
    assert r.status_code == 200, r.text
    rid = r.json()["id"]
    r = client.post(f"/api/reservations/{rid}/check-in", headers=h,
                    json={"room_id": room["id"], "amount_received": 0})
    assert r.status_code == 200, r.text
    # 今天提前退房（原订还剩 2 晚）
    r = client.post(f"/api/reservations/{rid}/check-out", headers=h, json={"force": True, "payments": []})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "checked_out"
    assert r.json()["actual_check_out"] == date.today().isoformat()

    # 正常退房（actual == check_out）不截断：同房再造一笔住满退房的对照（505 房）
    cin2 = (date.today() - timedelta(days=1)).isoformat()
    cout2 = date.today().isoformat()
    room2 = next(x for x in client.get("/api/rooms", headers=h).json() if x["room_number"] == "505")
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "正常退房客", "check_in": cin2, "check_out": cout2, "room_id": room2["id"],
    })
    assert r.status_code == 200, r.text
    rid2 = r.json()["id"]
    r = client.post(f"/api/reservations/{rid2}/check-in", headers=h,
                    json={"room_id": room2["id"], "amount_received": 0})
    assert r.status_code == 200, r.text
    r = client.post(f"/api/reservations/{rid2}/check-out", headers=h, json={"force": True, "payments": []})
    assert r.status_code == 200, r.text
    assert r.json()["actual_check_out"] == cout2  # 按期退房 = 原订离店日
    board = client.get("/api/rooms/board?days=14", headers=h).json()
    blk2 = next(b for g in board["groups"] for rm in g["rooms"] if rm["id"] == room2["id"]
                for b in rm["blocks"] if b["id"] == rid2)
    assert blk2["truncated"] is False
    assert "stub_nights" not in blk2 and "resale_nights" not in blk2

    # 当天入住、当天退房（1 晚房）：不允许被「未来住期」门槛挡住——当天即可退，且当晚放出续售
    room4 = next(x for x in client.get("/api/rooms", headers=h).json() if x["room_number"] == "506")
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "当天来当天走", "check_in": date.today().isoformat(),
        "check_out": (date.today() + timedelta(days=1)).isoformat(), "room_id": room4["id"],
    })
    assert r.status_code == 200, r.text
    rid4 = r.json()["id"]
    r = client.post(f"/api/reservations/{rid4}/check-in", headers=h,
                    json={"room_id": room4["id"], "amount_received": 0})
    assert r.status_code == 200, r.text
    r = client.post(f"/api/reservations/{rid4}/check-out", headers=h, json={"force": True, "payments": []})
    assert r.status_code == 200, r.text
    assert r.json()["actual_check_out"] == date.today().isoformat()
    # 日历上按「提前退房」截断：当天白天占房（存根 1 格压左 1/3），当晚尾段放出「可售」
    board = client.get("/api/rooms/board?days=14", headers=h).json()
    blk4 = next(b for g in board["groups"] for rm in g["rooms"] if rm["id"] == room4["id"]
                for b in rm["blocks"] if b["id"] == rid4)
    assert blk4["truncated"] is True
    assert blk4["stub_nights"] == 1 and blk4["stub_cut"] is True
    assert blk4["resale_nights"] == 1 and blk4["resale_mid"] is True

    # 存根整段窗外（实际离店日早于窗口起点）：灰块 nights=0 不渲染，只留「可售」虚纹
    cin3 = (date.today() - timedelta(days=6)).isoformat()
    cout3 = (date.today() + timedelta(days=1)).isoformat()
    room3 = next(x for x in client.get("/api/rooms", headers=h).json() if x["room_number"] == "508")
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "昨日已走客", "check_in": cin3, "check_out": cout3, "room_id": room3["id"],
    })
    assert r.status_code == 200, r.text
    rid3 = r.json()["id"]
    r = client.post(f"/api/reservations/{rid3}/check-in", headers=h,
                    json={"room_id": room3["id"], "amount_received": 0})
    assert r.status_code == 200, r.text
    # 直接把实际离店日改到 4 天前（窗口 start=今天-2 之前），模拟「人早就走了但订单没收尾」
    r = client.post(f"/api/reservations/{rid3}/check-out", headers=h, json={"force": True, "payments": []})
    assert r.status_code == 200, r.text
    from app.models import Reservation as _Res
    db = SessionLocal()
    _r = db.get(_Res, rid3)
    _r.actual_check_out = date.today() - timedelta(days=4)
    db.commit(); db.close()
    board = client.get("/api/rooms/board?days=14", headers=h).json()
    blk3 = next(b for g in board["groups"] for rm in g["rooms"] if rm["id"] == room3["id"]
                for b in rm["blocks"] if b["id"] == rid3)
    assert blk3["truncated"] is True
    assert blk3["nights"] == 0                # 前端按此跳过灰块渲染
    assert "stub_nights" not in blk3
    assert blk3["resale_nights"] >= 1         # 尾段虚纹仍要放出

    # 房态盘：灰块截断——实际离店日存根 + 可售区间
    board = client.get("/api/rooms/board?days=14", headers=h).json()
    blocks = [b for g in board["groups"] for rm in g["rooms"] if rm["id"] == room["id"] for b in rm["blocks"]]
    blk = next(b for b in blocks if b["id"] == rid)
    assert blk["truncated"] is True
    assert blk["stub_nights"] == 2            # 昨天 + 今天（存根含实际离店日）
    assert blk["stub_cut"] is True            # 存根末日 = 今天 → 压左 1/3
    assert blk["resale_nights"] == 2          # 今天尾段 + 明天
    assert blk["resale_mid"] is True          # 虚纹起点 = 存根末日 → 左侧留 1/3 齐平
    # 同房同时段再订（今天起 2 晚）→ 不再 409，创建成功
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "续售新客", "check_in": date.today().isoformat(),
        "check_out": (date.today() + timedelta(days=2)).isoformat(),
        "room_id": room["id"],
    })
    assert r.status_code == 200, r.text
    resold_id = r.json()["id"]

    # 尾段已售出时撤销退房 → 409（回到在住会与新订单双重占房）
    r = client.post(f"/api/reservations/{rid}/undo-check-out", headers=h)
    assert r.status_code == 409, r.text
    assert "conflicts" in r.json()["detail"]

    # 取消续售新单后再撤销退房：actual_check_out 清空，方块恢复原订跨度
    r = client.post(f"/api/reservations/{resold_id}/cancel", headers=h)
    assert r.status_code == 200, r.text
    r = client.post(f"/api/reservations/{rid}/undo-check-out", headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "checked_in"
    assert r.json()["actual_check_out"] is None
    board = client.get("/api/rooms/board?days=14", headers=h).json()
    blk = next(b for g in board["groups"] for rm in g["rooms"] if rm["id"] == room["id"]
               for b in rm["blocks"] if b["id"] == rid)
    assert blk["truncated"] is False
    assert blk["nights"] == 3                 # 恢复原订 3 晚
    assert "stub_nights" not in blk and "resale_nights" not in blk


def test_captcha_login_flow():
    """滑块验证码：出题 → 错误偏移 400 → 正确偏移换票据 → 登录必须带票据（一次性）"""
    import app.captcha as captcha
    from app.routers.auth import _captcha_hits, _login_attempts
    _login_attempts.clear()
    _captcha_hits.clear()
    captcha.set_enabled(True)
    try:
        r = client.get("/api/auth/captcha")
        assert r.status_code == 200, r.text
        q = r.json()
        assert q["enabled"] is True and q["bg"].startswith("data:image/svg+xml;base64,")
        answer = captcha._challenges[q["id"]]["x"]

        # 错误偏移：400，且题目作废（重取才能再试）
        r = client.post("/api/auth/captcha/verify", json={"id": q["id"], "x": answer + 40})
        assert r.status_code == 400, r.text
        assert q["id"] not in captcha._challenges

        # 正确偏移：拿到一次性票据
        q = client.get("/api/auth/captcha").json()
        answer = captcha._challenges[q["id"]]["x"]
        r = client.post("/api/auth/captcha/verify", json={"id": q["id"], "x": answer + 4})
        assert r.status_code == 200, r.text
        ticket = r.json()["captcha_token"]

        # 不带票据登录 → 400「请先完成滑块验证」
        r = client.post("/api/auth/login", json={"username": "zhouqi", "password": "123456", "hotel_id": 1})
        assert r.status_code == 400, r.text
        assert "滑块验证" in r.json()["detail"]

        # 带票据登录 → 200，且返回 refresh_token / expires_in
        r = client.post("/api/auth/login", json={
            "username": "zhouqi", "password": "123456", "hotel_id": 1, "captcha_token": ticket,
        })
        assert r.status_code == 200, r.text
        assert r.json()["refresh_token"]
        assert r.json()["expires_in"] > 0

        # 票据一次性：再用一次就失效
        r = client.post("/api/auth/login", json={
            "username": "zhouqi", "password": "123456", "hotel_id": 1, "captcha_token": ticket,
        })
        assert r.status_code == 400, r.text
    finally:
        captcha.set_enabled(False)
        _login_attempts.clear()
        _captcha_hits.clear()


def test_refresh_rotation_and_logout():
    """刷新令牌：轮换 → 新访问令牌可用 → 旧令牌宽限期后复用判定泄露 → 登出后 401"""
    from datetime import datetime, timedelta
    from app.models import RefreshToken
    from app.routers.auth import _login_attempts
    from app.security import hash_token
    _login_attempts.clear()

    login = _login("zhouqi", hotel_id=1)
    rt1 = login["refresh_token"]

    # 轮换：拿到新访问令牌与新刷新令牌
    r = client.post("/api/auth/refresh", json={"refresh_token": rt1})
    assert r.status_code == 200, r.text
    rt2 = r.json()["refresh_token"]
    assert rt2 and rt2 != rt1
    r = client.get("/api/auth/me", headers=_headers(r.json()["token"]))
    assert r.status_code == 200 and r.json()["username"] == "zhouqi"

    # 宽限期内：旧令牌仍可续一次（多标签页并发）
    r = client.post("/api/auth/refresh", json={"refresh_token": rt1})
    assert r.status_code == 200, r.text
    rt3 = r.json()["refresh_token"]

    # 超宽限（把旧记录的 revoked_at 拨回 2 分钟前）再复用 → 401 并吊销该用户全部令牌
    db = SessionLocal()
    rec = db.query(RefreshToken).filter(RefreshToken.token_hash == hash_token(rt1)).first()
    rec.revoked_at = datetime.now() - timedelta(minutes=2)
    db.commit(); db.close()
    r = client.post("/api/auth/refresh", json={"refresh_token": rt1})
    assert r.status_code == 401, r.text
    r = client.post("/api/auth/refresh", json={"refresh_token": rt3})
    assert r.status_code == 401, r.text  # 全量吊销生效

    # 登出：吊销后 refresh 401；重复登出仍 200（不探测令牌是否存在）
    fresh = _login("zhouqi", hotel_id=1)["refresh_token"]
    r = client.post("/api/auth/logout", json={"refresh_token": fresh})
    assert r.status_code == 200 and r.json()["ok"] is True
    assert client.post("/api/auth/refresh", json={"refresh_token": fresh}).status_code == 401
    assert client.post("/api/auth/logout", json={"refresh_token": fresh}).status_code == 200

    _login_attempts.clear()
