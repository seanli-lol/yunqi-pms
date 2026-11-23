"""冒烟测试：登录 / 建订 / 冲突 / 入住 / 退房 / 设净全链路"""
import os
import tempfile

# 测试库默认走临时 SQLite 文件；shell 里 export DB_ENGINE=mysql + DB_* 可让全套冒烟直打 MySQL
# （跑前需先 drop/create 独立 *_test 空库——测试假定空库起步，重跑会撞种子幂等）
os.environ.setdefault("DB_ENGINE", "sqlite")
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "test-pms.db")
# 冒烟测试默认不要求滑块验证码（验证码专项用例里用 captcha.set_enabled 单独开关）
os.environ["CAPTCHA"] = "off"

from fastapi.testclient import TestClient  # noqa: E402

from app.db import Base, SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Hotel  # noqa: E402
from app.routers.payment_methods import ensure_default_methods  # noqa: E402
from app.seed import ensure_seed  # noqa: E402

Base.metadata.create_all(bind=engine)
_seed_db = SessionLocal()
ensure_seed(_seed_db)
# 与 main.lifespan 对齐：每家酒店补种默认收款方式（测试不走 lifespan）
for _h in _seed_db.query(Hotel).all():
    ensure_default_methods(_seed_db, _h.id)
_seed_db.commit()
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

    room = pick("大床房")  # 大床房已配钟点价 45；未配钟点价的观景大床房/亲子房留到后面做拒绝断言
    # 时长越界
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "钟点客", "check_in": cin, "check_out": cout,
        "room_id": room["id"], "stay_type": "hourly", "hours": 20,
    })
    assert r.status_code == 400
    # 正常创建：房型已配钟点价，手动传价 45（协议价）放行
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
    assert folio["items"][0]["description"] == "钟点房费 · 4 小时 × ¥45.00"
    assert folio["total_charge"] == 180
    # 入住 → 退房
    r = client.post(f"/api/reservations/{res['id']}/check-in", headers=h,
                    json={"room_id": room["id"], "amount_received": 180, "payment_method": "cash"})
    assert r.status_code == 200, r.text
    r = client.post(f"/api/reservations/{res['id']}/check-out", headers=h,
                    json={"force": False, "payments": []})
    assert r.status_code == 200, r.text
    assert r.json()["balance_due"] == 0
    # 未配钟点价的房型：不传价、显式传价都 → 400（观景大床房 / 亲子房 hourly_price=0）
    for tname in ("观景大床房", "亲子房"):
        room2 = pick(tname)
        for extra in ({}, {"rate": 45}):
            r = client.post("/api/reservations", headers=h, json={
                "guest_name": "钟点客3", "check_in": cin, "check_out": cout,
                "room_id": room2["id"], "stay_type": "hourly", "hours": 3, **extra,
            })
            assert r.status_code == 400, f"{tname} extra={extra}: {r.text}"
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
    # 产生一条收款日志（带备注：folio 返回 remark，摘要追加备注原文）
    r = client.post(f"/api/reservations/{rid}/payments", headers=h,
                    json={"method": "wechat", "amount": 100, "remark": "代收押金"})
    assert r.status_code == 200
    folio = client.get(f"/api/reservations/{rid}/folio", headers=h).json()
    assert folio["payments"][0]["remark"] == "代收押金"
    r = client.get(f"/api/reservations/{rid}/logs", headers=h)
    assert r.status_code == 200
    logs = r.json()
    actions = [o["action"] for o in logs]
    assert "reservation_create" in actions and "payment" in actions
    assert all(set(o) >= {"time", "action", "summary", "operator"} for o in logs)
    # 倒序：最新在前
    assert logs[0]["action"] == "payment"
    assert "备注「代收押金」" in logs[0]["summary"]
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
    # 日历上按「提前退房」截断：当天白天占房（存根 1 格压左 1/3）；当日往返存根
    # （stub_nights==1 + checked_out）由前端聚合为格角「退房」角标，「可售」虚纹已退役
    board = client.get("/api/rooms/board?days=14", headers=h).json()
    blk4 = next(b for g in board["groups"] for rm in g["rooms"] if rm["id"] == room4["id"]
                for b in rm["blocks"] if b["id"] == rid4)
    assert blk4["truncated"] is True
    assert blk4["stub_nights"] == 1 and blk4["stub_cut"] is True
    assert "resale_nights" not in blk4 and "resale_mid" not in blk4
    assert blk4["items_total"] >= 0 and blk4["paid_total"] >= 0   # 角标明细卡的金额分列

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
    assert blk3["nights"] == 0                # 前端按此跳过渲染（虚纹退役后无可视部分）
    assert "stub_nights" not in blk3
    assert "resale_nights" not in blk3

    # 房态盘：灰块截断——实际离店日存根 + 可售区间
    board = client.get("/api/rooms/board?days=14", headers=h).json()
    blocks = [b for g in board["groups"] for rm in g["rooms"] if rm["id"] == room["id"] for b in rm["blocks"]]
    blk = next(b for b in blocks if b["id"] == rid)
    assert blk["truncated"] is True
    assert blk["stub_nights"] == 2            # 昨天 + 今天（存根含实际离店日）
    assert blk["stub_cut"] is True            # 存根末日 = 今天 → 压左 1/3
    assert "resale_nights" not in blk and "resale_mid" not in blk
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


def test_pay_methods_config_and_payment_validation():
    """收款方式配置：默认项 / 重名拦截 / 改名 / 停用拦截收款 / 删除保护转停用 / 日志留痕"""
    from datetime import date, timedelta

    tok = _login("wanglin", hotel_id=1)["token"]
    h = _headers(tok)

    # 启动补种：默认 4 项齐全（code 与存量 payments.method 对齐）
    ms = client.get("/api/payment-methods", headers=h).json()
    assert {"cash", "wechat", "alipay", "card"} <= {m["code"] for m in ms}

    # 新增自定义方式 → 生成 pm_ 前缀 code；同店重名 → 400
    r = client.post("/api/payment-methods", headers=h, json={"name": "协议挂账", "remark": "月末统一结算"})
    assert r.status_code == 200, r.text
    pm = r.json()
    assert pm["code"].startswith("pm_") and pm["is_active"]
    r = client.post("/api/payment-methods", headers=h, json={"name": "协议挂账"})
    assert r.status_code == 400

    # 改名生效（历史收款不受影响：payments 存的是 code）
    r = client.patch(f"/api/payment-methods/{pm['id']}", headers=h, json={"name": "协议挂账（月结）"})
    assert r.status_code == 200 and r.json()["name"] == "协议挂账（月结）"

    # 一单在住预订：动态挑空净房，避开其他用例占用的房号
    rooms = client.get("/api/rooms", headers=h).json()
    rid = None
    for room in [x for x in rooms if x["status"] == "vacant_clean"]:
        r = client.post("/api/reservations", headers=h, json={
            "guest_name": "收款方式测试客", "check_in": date.today().isoformat(),
            "check_out": (date.today() + timedelta(days=1)).isoformat(),
            "room_id": room["id"], "status": "confirmed",
        })
        if r.status_code == 200:
            rid = r.json()["id"]
            break
    assert rid, "没有可用的空净房"
    r = client.post(f"/api/reservations/{rid}/check-in", headers=h, json={"room_id": room["id"]})
    assert r.status_code == 200, r.text

    # 未配置的 code → 400；自定义方式 → 200
    r = client.post(f"/api/reservations/{rid}/payments", headers=h, json={"method": "gold", "amount": 100})
    assert r.status_code == 400
    r = client.post(f"/api/reservations/{rid}/payments", headers=h, json={"method": pm["code"], "amount": 100})
    assert r.status_code == 200, r.text

    # 停用后不可再用于收款，启用后恢复
    r = client.patch(f"/api/payment-methods/{pm['id']}", headers=h, json={"is_active": False})
    assert r.status_code == 200
    r = client.post(f"/api/reservations/{rid}/payments", headers=h, json={"method": pm["code"], "amount": 50})
    assert r.status_code == 400
    client.patch(f"/api/payment-methods/{pm['id']}", headers=h, json={"is_active": True})

    # 删除保护：有收款记录 → 转停用不物理删
    r = client.delete(f"/api/payment-methods/{pm['id']}", headers=h)
    assert r.status_code == 200 and r.json()["disabled"] is True
    ms = client.get("/api/payment-methods", headers=h, params={"include_inactive": "true"}).json()
    assert any(m["id"] == pm["id"] and not m["is_active"] for m in ms)

    # 操作留痕：paymethod_* 动作进报表单日明细
    day = client.get(f"/api/reports/day?day={date.today().isoformat()}", headers=h).json()
    actions = [o["action"] for o in day["operations"]]
    assert {"paymethod_create", "paymethod_update", "paymethod_disable"} <= set(actions)


def test_guest_notes_edit():
    """客户备注编辑：PATCH 更新 + 名单/详情可见"""
    tok = _login("zhouqi", hotel_id=1)["token"]
    h = _headers(tok)
    r = client.post("/api/guests", headers=h, json={"name": "备注客", "phone": "13700009999"})
    assert r.status_code == 200, r.text
    gid = r.json()["id"]
    r = client.patch(f"/api/guests/{gid}", headers=h, json={"notes": "喜欢高楼层，忌辣"})
    assert r.status_code == 200, r.text
    out = client.get(f"/api/guests/{gid}", headers=h).json()
    assert out["notes"] == "喜欢高楼层，忌辣"
    lst = client.get("/api/guests?q=备注客", headers=h).json()
    assert any(g["id"] == gid and g["notes"] == "喜欢高楼层，忌辣" for g in lst)
    # 非本店员工不可改（莫干山店员工改西湖店客户 → 404）
    hotels = client.get("/api/hotels", headers=_headers(_login("admin")["token"])).json()
    mogan = next(x["id"] for x in hotels if "莫干山店" in x["name"])
    tok2 = _login("xumin", hotel_id=mogan)["token"]
    r = client.patch(f"/api/guests/{gid}", headers=_headers(tok2), json={"notes": "x"})
    assert r.status_code == 404


def test_guest_profile_and_dup():
    """客户档案查重与编辑：手机号/证件号同店撞档 400；编辑排除自身；q 支持证件号；跨店同号放行"""
    tok = _login("zhouqi", hotel_id=1)["token"]
    h = _headers(tok)
    r = client.post("/api/guests", headers=h, json={
        "name": "查重甲", "phone": "13788880001", "id_number": "330106199001010011"})
    assert r.status_code == 200, r.text
    gid_a = r.json()["id"]
    # 建档：手机号/证件号撞已有档案 → 400 报出档案名
    r = client.post("/api/guests", headers=h, json={"name": "查重乙", "phone": "13788880001"})
    assert r.status_code == 400 and "手机号已属于客户档案" in r.json()["detail"]
    r = client.post("/api/guests", headers=h, json={
        "name": "查重丙", "id_number": "330106199001010011"})
    assert r.status_code == 400 and "证件号已属于客户档案" in r.json()["detail"]
    # 编辑：改成 A 占用的手机号/证件号 → 400
    r = client.post("/api/guests", headers=h, json={"name": "查重丁", "phone": "13788880002"})
    assert r.status_code == 200, r.text
    gid_b = r.json()["id"]
    r = client.patch(f"/api/guests/{gid_b}", headers=h,
                     json={"phone": "13788880001", "id_number": "330106199001010011"})
    assert r.status_code == 400 and "手机号已属于客户档案" in r.json()["detail"]
    r = client.patch(f"/api/guests/{gid_b}", headers=h,
                     json={"id_number": "330106199001010011"})
    assert r.status_code == 400 and "证件号已属于客户档案" in r.json()["detail"]
    # 编辑：排除自身（A 手机号不变 + 证件号换新值）→ 成功且 q 可按证件号搜、详情可见
    r = client.patch(f"/api/guests/{gid_a}", headers=h,
                     json={"phone": "13788880001", "id_number": "330106199001012345"})
    assert r.status_code == 200, r.text
    lst = client.get("/api/guests?q=330106199001012345", headers=h).json()
    assert any(g["id"] == gid_a for g in lst)
    detail = client.get(f"/api/guests/{gid_a}", headers=h).json()
    assert detail["id_number"] == "330106199001012345"
    # 空 PATCH（无变更）→ ok；姓名清空 → 400
    assert client.patch(f"/api/guests/{gid_a}", headers=h, json={}).status_code == 200
    r = client.patch(f"/api/guests/{gid_a}", headers=h, json={"name": "   "})
    assert r.status_code == 400
    # 跨店同号放行（查重是同店口径）：莫干山店建同手机号/证件号档案 → 成功
    hotels = client.get("/api/hotels", headers=_headers(_login("admin")["token"])).json()
    mogan = next(x["id"] for x in hotels if "莫干山店" in x["name"])
    tok2 = _login("xumin", hotel_id=mogan)["token"]
    r = client.post("/api/guests", headers=_headers(tok2), json={
        "name": "莫干查重客", "phone": "13788880001", "id_number": "330106199001010011"})
    assert r.status_code == 200, r.text
    # 预订带新客人档案：证件号撞本店已有档案（查重甲现用 …12345）→ 400 引导走客人联想
    r = client.post("/api/reservations", headers=h, json={
        "room_type_id": 1, "guest_name": "新客戊", "guest_phone": "13788880009",
        "guest_id_number": "330106199001012345",
        "check_in": "2026-12-01", "check_out": "2026-12-02"})
    assert r.status_code == 400 and "请在客人联想中选择该档案" in r.json()["detail"]


def test_delete_payment():
    """订单详情收款表行内删除：仅 checked_in/checked_out 可删；物理删除 + payment_delete 日志 + 余额重算"""
    from datetime import date, timedelta
    tok = _login("zhouqi", hotel_id=1)["token"]
    h = _headers(tok)
    rooms = client.get("/api/rooms", headers=h).json()
    rid = None
    for room in [x for x in rooms if x["status"] == "vacant_clean"]:
        r = client.post("/api/reservations", headers=h, json={
            "guest_name": "删款测试客", "check_in": date.today().isoformat(),
            "check_out": (date.today() + timedelta(days=1)).isoformat(),
            "room_id": room["id"], "status": "confirmed",
        })
        if r.status_code == 200:
            rid = r.json()["id"]
            break
    assert rid, "没有可用的空净房"
    r = client.post(f"/api/reservations/{rid}/check-in", headers=h, json={"room_id": room["id"]})
    assert r.status_code == 200, r.text

    # 两笔收款（现金 100 带备注 + 微信 50）
    r = client.post(f"/api/reservations/{rid}/payments", headers=h,
                    json={"method": "cash", "amount": 100, "remark": "现金押金"})
    assert r.status_code == 200
    r = client.post(f"/api/reservations/{rid}/payments", headers=h, json={"method": "wechat", "amount": 50})
    assert r.status_code == 200
    folio = client.get(f"/api/reservations/{rid}/folio", headers=h).json()
    assert folio["total_paid"] == 150
    assert folio["payments"][0]["remark"] == "现金押金"
    assert folio["payments"][1]["remark"] == ""
    p1, p2 = folio["payments"][0], folio["payments"][1]

    # 删除第二笔 → 物理删除 + 余额重算
    r = client.delete(f"/api/reservations/{rid}/payments/{p2['id']}", headers=h)
    assert r.status_code == 200, r.text
    bal = r.json()["balance_due"]
    folio = client.get(f"/api/reservations/{rid}/folio", headers=h).json()
    assert folio["total_paid"] == 100
    assert folio["balance_due"] == bal
    assert all(p["id"] != p2["id"] for p in folio["payments"])

    # 日志：payment_delete 聚合进预订日志，摘要含金额；收款日志带备注原文
    logs = client.get(f"/api/reservations/{rid}/logs", headers=h).json()
    actions = [o["action"] for o in logs]
    assert "payment_delete" in actions
    latest = next(o for o in logs if o["action"] == "payment_delete")
    assert "¥50" in latest["summary"]
    pay_log = next(o for o in logs if o["action"] == "payment" and "¥100" in o["summary"])
    assert "备注「现金押金」" in pay_log["summary"]

    # 备注超 120 字 → 400
    r = client.post(f"/api/reservations/{rid}/payments", headers=h,
                    json={"method": "cash", "amount": 10, "remark": "字" * 121})
    assert r.status_code == 400

    # 不存在的收款 → 404；他人酒店员工跨店删 → 404
    r = client.delete(f"/api/reservations/{rid}/payments/999999", headers=h)
    assert r.status_code == 404
    hotels = client.get("/api/hotels", headers=_headers(_login("admin")["token"])).json()
    mogan = next(x["id"] for x in hotels if "莫干山店" in x["name"])
    tok2 = _login("xumin", hotel_id=mogan)["token"]
    r = client.delete(f"/api/reservations/{rid}/payments/{p1['id']}", headers=_headers(tok2))
    assert r.status_code == 404

    # 未来 confirmed 预订（定金场景）：状态口径对齐 paid-total → 400
    rooms2 = client.get("/api/rooms", headers=h).json()
    avail_room = next(x for x in rooms2 if x["status"] == "vacant_clean")
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "删款预订客", "check_in": (date.today() + timedelta(days=70)).isoformat(),
        "check_out": (date.today() + timedelta(days=71)).isoformat(),
        "room_id": avail_room["id"], "status": "confirmed",
    })
    assert r.status_code == 200, r.text
    rid2 = r.json()["id"]
    r = client.post(f"/api/reservations/{rid2}/payments", headers=h, json={"method": "cash", "amount": 80})
    assert r.status_code == 200
    pid2 = client.get(f"/api/reservations/{rid2}/folio", headers=h).json()["payments"][0]["id"]
    r = client.delete(f"/api/reservations/{rid2}/payments/{pid2}", headers=h)
    assert r.status_code == 400


def test_room_edit_and_duplicate_guard():
    from app.routers.auth import _login_attempts
    _login_attempts.clear()  # 测试共用 client IP，避免触发每分钟 10 次的登录限流
    tok = _login("wanglin", hotel_id=1)["token"]
    h = _headers(tok)
    types = client.get("/api/room-types", headers=h).json()
    assert len(types) >= 2
    r = client.post("/api/rooms", headers=h, json={"room_number": "9901", "floor": 9, "room_type_id": types[0]["id"]})
    assert r.status_code == 200, r.text
    room = r.json()
    r = client.post("/api/rooms", headers=h, json={"room_number": "9902", "floor": 9, "room_type_id": types[0]["id"]})
    assert r.status_code == 200, r.text

    # 编辑：房号/楼层/房型/备注一次改齐
    other_type = next(t for t in types if t["id"] != types[0]["id"])
    r = client.patch(f"/api/rooms/{room['id']}", headers=h, json={
        "room_number": "9903", "floor": 3, "room_type_id": other_type["id"], "notes": "空调检修"})
    assert r.status_code == 200, r.text
    data = r.json()
    assert (data["room_number"], data["floor"], data["room_type_id"], data["notes"]) == \
        ("9903", 3, other_type["id"], "空调检修")

    # 房号撞同店其他客房 → 400；提交自身原房号（排除自身）→ 200 不打日志
    r = client.patch(f"/api/rooms/{room['id']}", headers=h, json={"room_number": "9902"})
    assert r.status_code == 400
    r = client.patch(f"/api/rooms/{room['id']}", headers=h, json={"room_number": "9903"})
    assert r.status_code == 200

    # 空房号 → 400；房型不存在 → 400
    r = client.patch(f"/api/rooms/{room['id']}", headers=h, json={"room_number": "  "})
    assert r.status_code == 400
    r = client.patch(f"/api/rooms/{room['id']}", headers=h, json={"room_type_id": 999999})
    assert r.status_code == 400

    # 纯房态切换口径不变（操作列下拉走 status-only PATCH）
    r = client.patch(f"/api/rooms/{room['id']}", headers=h, json={"status": "vacant_dirty"})
    assert r.status_code == 200 and r.json()["status"] == "vacant_dirty"

    # 跨店隔离：莫干山店员工改西湖店客房 → 404
    hotels = client.get("/api/hotels", headers=_headers(_login("admin")["token"])).json()
    mogan = next(x["id"] for x in hotels if "莫干山店" in x["name"])
    tok2 = _login("xumin", hotel_id=mogan)["token"]
    r = client.patch(f"/api/rooms/{room['id']}", headers=_headers(tok2), json={"notes": "跨店"})
    assert r.status_code == 404


def test_room_delete_guard():
    """客房删除：无预订可删（记 room_delete 日志）+ 有预订记录（含已取消历史）拒绝 + 再删 404 + 跨店 404"""
    from app.routers.auth import _login_attempts
    _login_attempts.clear()  # 测试共用 client IP，避免触发每分钟 10 次的登录限流
    tok = _login("wanglin", hotel_id=1)["token"]
    h = _headers(tok)
    types = client.get("/api/room-types", headers=h).json()
    r = client.post("/api/rooms", headers=h, json={"room_number": "9905", "floor": 9, "room_type_id": types[0]["id"]})
    assert r.status_code == 200, r.text
    room = r.json()

    # 有预订记录（未到店）→ 400；取消后仍是历史记录 → 依旧拒绝（历史完整性口径）
    from datetime import date, timedelta
    cin = (date.today() + timedelta(days=30)).isoformat()
    cout = (date.today() + timedelta(days=31)).isoformat()
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "删房测试客", "check_in": cin, "check_out": cout,
        "room_id": room["id"], "notes": "占住防删",
    })
    assert r.status_code == 200, r.text
    res_id = r.json()["id"]
    r = client.delete(f"/api/rooms/{room['id']}", headers=h)
    assert r.status_code == 400
    r = client.post(f"/api/reservations/{res_id}/cancel", headers=h)
    assert r.status_code == 200, r.text
    r = client.delete(f"/api/rooms/{room['id']}", headers=h)
    assert r.status_code == 400

    # 无任何预订记录的客房：可删除；再删 → 404
    r = client.post("/api/rooms", headers=h, json={"room_number": "9906", "floor": 9, "room_type_id": types[0]["id"]})
    assert r.status_code == 200, r.text
    room2 = r.json()
    r = client.delete(f"/api/rooms/{room2['id']}", headers=h)
    assert r.status_code == 200 and r.json()["ok"] is True
    r = client.delete(f"/api/rooms/{room2['id']}", headers=h)
    assert r.status_code == 404

    # 跨店隔离：莫干山店员工删西湖店客房 → 404
    hotels = client.get("/api/hotels", headers=_headers(_login("admin")["token"])).json()
    mogan = next(x["id"] for x in hotels if "莫干山店" in x["name"])
    tok2 = _login("xumin", hotel_id=mogan)["token"]
    r = client.delete(f"/api/rooms/{room['id']}", headers=_headers(tok2))
    assert r.status_code == 404


def test_hotel_edit_and_toggle():
    """酒店编辑：局部更新 null=不改 + 营业/筹备切换影响登录页下拉 + 空名 400 + 非平台管理员 403"""
    from app.routers.auth import _login_attempts
    _login_attempts.clear()  # 测试共用 client IP，避免触发每分钟 10 次的登录限流
    h = _headers(_login("admin")["token"])  # 平台管理员不选酒店
    hotels = client.get("/api/hotels", headers=h).json()
    west = next(x for x in hotels if "西湖店" in x["name"])

    # 编辑四字段一次改齐 + 停用（筹备中）
    r = client.patch(f"/api/hotels/{west['id']}", headers=h, json={
        "name": "云栖酒店 · 西湖店", "city": "杭州", "address": "西湖区龙井路 99 号",
        "contact_name": "王琳", "is_active": False})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["address"] == "西湖区龙井路 99 号" and data["is_active"] is False

    # 停用后登录页下拉不再出现（public 只出启用店）
    assert all(x["id"] != west["id"] for x in client.get("/api/hotels/public").json())

    # 局部更新口径：只传 is_active，其余字段不动（null=不改）
    r = client.patch(f"/api/hotels/{west['id']}", headers=h, json={"is_active": True})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["is_active"] is True and data["name"] == "云栖酒店 · 西湖店" \
        and data["address"] == "西湖区龙井路 99 号"
    assert any(x["id"] == west["id"] for x in client.get("/api/hotels/public").json())

    # 空名 → 400；酒店管理员非平台管理员 → 403
    r = client.patch(f"/api/hotels/{west['id']}", headers=h, json={"name": "  "})
    assert r.status_code == 400
    tok2 = _login("wanglin", hotel_id=1)["token"]
    r = client.patch(f"/api/hotels/{west['id']}", headers=_headers(tok2), json={"name": "越权改名"})
    assert r.status_code == 403


def test_pii_field_encryption_and_masking():
    """PII 静态加密：证件号库内密文不可读（含存量明文回填）+ 搜索/查重/详情照常 + 日志摘要掩码 + 密码哈希形态"""
    from app.db import backfill_encrypted_fields
    from app.models import Guest, OperationLog, User
    from app.routers.auth import _login_attempts
    from app.security import decrypt_field

    _login_attempts.clear()
    tok = _headers(_login("zhouqi", hotel_id=1)["token"])

    # 建档（API 收明文）→ 库内是 enc1: 密文，不含明文片段，解密往返一致
    r = client.post("/api/guests", headers=tok, json={
        "name": "加密验证客", "phone": "13900009999", "id_number": "330106199001011234"})
    assert r.status_code == 200, r.text
    gid = r.json()["id"]
    db = SessionLocal()
    g = db.get(Guest, gid)
    assert g.id_number.startswith("enc1:")
    assert "199001011234" not in g.id_number
    assert decrypt_field(g.id_number) == "330106199001011234"

    # 存量明文回填：手工改回明文 → backfill 一次加密（幂等，enc1: 前缀视为已加密跳过）
    g.id_number = "330106199001011234"
    db.commit()
    backfill_encrypted_fields(db)
    backfill_encrypted_fields(db)  # 连跑两次验证幂等
    db.expire_all()
    g2 = db.get(Guest, gid)
    assert g2.id_number.startswith("enc1:") and "199001011234" not in g2.id_number
    assert decrypt_field(g2.id_number) == "330106199001011234"
    db.close()

    # API 仍返回明文（客户页明文口径不变）；q 按证件片段搜索照常可用（解密后内存过滤）
    r = client.get(f"/api/guests/{gid}", headers=tok)
    assert r.status_code == 200 and r.json()["id_number"] == "330106199001011234"
    r = client.get("/api/guests", params={"q": "199001011234"}, headers=tok)
    assert r.status_code == 200
    assert any(x["id"] == gid for x in r.json())

    # 同店撞证件号 → 400（内存解密查重）
    r = client.post("/api/guests", headers=tok, json={
        "name": "撞证号客", "phone": "13900009998", "id_number": "330106199001011234"})
    assert r.status_code == 400 and "客户档案" in r.json()["detail"]

    # 编辑证件号 → 日志摘要只落掩码（前3+***+后4），不落明文 A→B
    r = client.patch(f"/api/guests/{gid}", headers=tok, json={"id_number": "330106199202022345"})
    assert r.status_code == 200, r.text
    db = SessionLocal()
    log = (db.query(OperationLog)
           .filter(OperationLog.action == "guest_update", OperationLog.object_id == gid)
           .order_by(OperationLog.id.desc()).first())
    db.close()
    assert log is not None
    assert "证件号 330***1234→330***2345" in log.summary
    assert "199001011234" not in log.summary and "199202022345" not in log.summary

    # 密码：库内只有加盐 PBKDF2（salt$digest = 32hex$64hex），无明文
    db = SessionLocal()
    u = db.query(User).filter(User.username == "zhouqi").first()
    db.close()
    salt, digest = u.password_hash.split("$", 1)
    assert len(salt) == 32 and len(digest) == 64
    assert "123456" not in u.password_hash


def test_decimal_amounts():
    """金额支持到分：房价/房费/收款两位小数全链路 + 入参规整到分 + 日志金额格式"""
    from datetime import date, timedelta

    from app.routers.auth import _login_attempts

    _login_attempts.clear()
    tok = _headers(_login("zhouqi", hotel_id=1)["token"])
    cin = date.today().isoformat()
    cout = (date.today() + timedelta(days=2)).isoformat()

    types = client.get("/api/room-types", headers=tok).json()

    # 房型价格支持小数：新建 288.6 / 钟点 45.5 → 读回一致
    r = client.post("/api/room-types", headers=tok, json={
        "name": "小数价房型", "base_price": 288.6, "hourly_price": 45.5})
    assert r.status_code == 200, r.text
    assert r.json()["base_price"] == 288.6 and r.json()["hourly_price"] == 45.5

    # 建订：单价 299.99 × 2 晚 = 599.98（协议价带小数）
    t = next(x for x in types if x["name"] == "双床房")
    av = client.get(
        f"/api/rooms/available?room_type_id={t['id']}&check_in={cin}&check_out={cout}"
        f"&include_dirty=1&allow_prev_guest=1", headers=tok).json()
    idle = [x for x in av if x["status"] in ("vacant_clean", "vacant_dirty")]
    assert idle, "双床房无可用空房"
    room = idle[0]
    r = client.post("/api/reservations", headers=tok, json={
        "guest_name": "小数客", "check_in": cin, "check_out": cout,
        "room_id": room["id"], "rate": 299.99, "status": "confirmed"})
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["rate"] == 299.99
    assert res["balance_due"] == 599.98
    folio = client.get(f"/api/reservations/{res['id']}/folio", headers=tok).json()
    assert folio["items"][0]["description"] == "房费 · 2 晚 × ¥299.99"
    assert folio["total_charge"] == 599.98

    # 入住实收小数 100.55 → 余额 499.43
    r = client.post(f"/api/reservations/{res['id']}/check-in", headers=tok,
                    json={"room_id": room["id"], "amount_received": 100.55,
                          "payment_method": "wechat"})
    assert r.status_code == 200, r.text
    folio = client.get(f"/api/reservations/{res['id']}/folio", headers=tok).json()
    assert folio["total_paid"] == 100.55
    assert folio["balance_due"] == 499.43

    # 入参 10.005 规整到 10.01（half-up 到分）：加收杂费
    r = client.post(f"/api/reservations/{res['id']}/folio-items", headers=tok,
                    json={"category": "other", "description": "洗衣费", "amount": 10.005})
    assert r.status_code == 200, r.text
    folio = client.get(f"/api/reservations/{res['id']}/folio", headers=tok).json()
    assert folio["items"][-1]["amount"] == 10.01
    assert folio["total_charge"] == 609.99  # 599.98 + 10.01

    # 未结清退房 → 409（余额带分值）
    r = client.post(f"/api/reservations/{res['id']}/check-out", headers=tok,
                    json={"payments": []})
    assert r.status_code == 409
    assert r.json()["detail"]["balance_due"] == 509.44  # 609.99 - 100.55

    # 随退房收款 509.44 结清
    r = client.post(f"/api/reservations/{res['id']}/check-out", headers=tok, json={
        "payments": [{"method": "cash", "amount": 509.44}]})
    assert r.status_code == 200, r.text
    assert r.json()["balance_due"] == 0
    folio = client.get(f"/api/reservations/{res['id']}/folio", headers=tok).json()
    assert folio["total_paid"] == 609.99

    # 更正实收（已退房可操作）：目标 700.50 → 补收 90.51；再改回 609.99 → 整笔冲减 90.51
    r = client.patch(f"/api/reservations/{res['id']}/paid-total", headers=tok,
                     json={"amount": 700.5, "method": "cash"})
    assert r.status_code == 200, r.text
    folio = client.get(f"/api/reservations/{res['id']}/folio", headers=tok).json()
    assert folio["total_paid"] == 700.5
    assert folio["balance_due"] == -90.51  # 超付（负余额原样返回）
    r = client.patch(f"/api/reservations/{res['id']}/paid-total", headers=tok,
                     json={"amount": 609.99, "method": "cash"})
    assert r.status_code == 200, r.text
    folio = client.get(f"/api/reservations/{res['id']}/folio", headers=tok).json()
    assert folio["total_paid"] == 609.99

    # 日志金额统一两位小数格式
    logs = client.get(f"/api/reservations/{res['id']}/logs", headers=tok).json()
    summaries = [x["summary"] for x in logs]
    assert any("入住实收 ¥100.55" in s for s in summaries)
    assert any("收款 ¥509.44" in s for s in summaries)
    assert any("更正实收 ¥609.99→¥700.50（补收 ¥90.51" in s for s in summaries)
    assert any("更正实收 ¥700.50→¥609.99（冲减 ¥90.51，无退款凭证）" in s for s in summaries)

    # 钟点房：单价 45.5 × 4 小时 = 182.00（显式传协议价放行）
    t2 = next(x for x in types if x["name"] == "大床房")
    av2 = client.get(
        f"/api/rooms/available?room_type_id={t2['id']}&check_in={cin}&check_out={cout}"
        f"&include_dirty=1&allow_prev_guest=1", headers=tok).json()
    idle2 = [x for x in av2 if x["status"] in ("vacant_clean", "vacant_dirty")]
    assert idle2, "大床房无可用空房"
    room2 = idle2[0]
    r = client.post("/api/reservations", headers=tok, json={
        "guest_name": "小数钟点客", "check_in": cin, "check_out": cout,
        "room_id": room2["id"], "stay_type": "hourly", "hours": 4, "rate": 45.5,
        "status": "confirmed"})
    assert r.status_code == 200, r.text
    res2 = r.json()
    assert res2["rate"] == 45.5
    folio2 = client.get(f"/api/reservations/{res2['id']}/folio", headers=tok).json()
    assert folio2["items"][0]["description"] == "钟点房费 · 4 小时 × ¥45.50"
    assert folio2["total_charge"] == 182.0


def test_hourly_price_is_editable():
    """钟点房价可议价：reservations.rate 是「每小时单价」，账目 = hours × rate。
    前端把「整单总额 ÷ 小时数」折算成 rate 提交（曾按天数折算导致 4h ¥200 记成 ¥800）。"""
    from datetime import date, timedelta

    from app.routers.auth import _login_attempts

    _login_attempts.clear()
    h = _headers(_login("zhouqi", hotel_id=1)["token"])
    cin = date.today().isoformat()
    cout = (date.today() + timedelta(days=1)).isoformat()
    types = {t["name"]: t for t in client.get("/api/room-types", headers=h).json()}

    def pick(type_name):
        t = types[type_name]
        av = client.get(
            f"/api/rooms/available?room_type_id={t['id']}&check_in={cin}&check_out={cout}"
            f"&include_dirty=1&allow_prev_guest=1", headers=h).json()
        idle = [x for x in av if x["status"] in ("vacant_clean", "vacant_dirty")]
        assert idle, f"{type_name} 无可用空房"
        # 依次取用，避免本测试内两单抢同一间房
        pick.used = getattr(pick, "used", set())
        for x in idle:
            if x["id"] not in pick.used:
                pick.used.add(x["id"])
                return x
        raise AssertionError("可用房已耗尽")

    # 房型基准钟点价 45/小时；议价到 50/小时（4 小时整单 ¥200 → rate = 200 ÷ 4 = 50）
    room = pick("大床房")
    assert types["大床房"]["hourly_price"] == 45.0
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "议价钟点客", "check_in": cin, "check_out": cout,
        "room_id": room["id"], "stay_type": "hourly", "hours": 4, "rate": 50,
        "status": "confirmed",
    })
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["stay_type"] == "hourly" and res["hours"] == 4
    assert res["rate"] == 50.0           # 存的是每小时单价，不是整单总额
    folio = client.get(f"/api/reservations/{res['id']}/folio", headers=h).json()
    assert folio["items"][0]["description"] == "钟点房费 · 4 小时 × ¥50.00"
    assert folio["total_charge"] == 200.0   # 用户填的整单总额原样入账

    # 议价低于系统价同样放行（钟点价可下调，如协议客）
    room2 = pick("大床房")
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "协议钟点客", "check_in": cin, "check_out": cout,
        "room_id": room2["id"], "stay_type": "hourly", "hours": 2, "rate": 30,
        "status": "confirmed",
    })
    assert r.status_code == 200, r.text
    res2 = r.json()
    assert res2["rate"] == 30.0
    folio2 = client.get(f"/api/reservations/{res2['id']}/folio", headers=h).json()
    assert folio2["total_charge"] == 60.0    # 2 小时 × 30

    # 未配钟点价的房型仍不可按钟点售卖（铁律不因议价放开）
    room3 = pick("观景大床房")
    r = client.post("/api/reservations", headers=h, json={
        "guest_name": "无钟点价客", "check_in": cin, "check_out": cout,
        "room_id": room3["id"], "stay_type": "hourly", "hours": 4, "rate": 50,
        "status": "confirmed",
    })
    assert r.status_code == 400
    assert "未配置钟点价" in r.json()["detail"]
