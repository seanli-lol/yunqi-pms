"""演示数据种子：与阶段一 UI 设计稿一致的云栖酒店数据（日期相对今天生成）"""
import uuid
from datetime import date, datetime, timedelta

from sqlalchemy.orm import Session

from app import config
from app.deps import fmt_money, money
from app.models import (Channel, FolioItem, Guest, Hotel, HourlyRate,
                        OperationLog, Payment, Reservation, Room, RoomType, User)
from app.security import encrypt_field, hash_password


def _d(offset: int) -> date:
    return date.today() + timedelta(days=offset)


def _dt(offset_days: int, hh: int, mm: int) -> datetime:
    return datetime.combine(_d(offset_days), datetime.min.time()).replace(hour=hh, minute=mm)


# 演示钟点档位（price = 该时长整单总价）：原 45/h、55/h 的多档化版本
TIERS_BIG = [(2, 80), (3, 90), (4, 110), (6, 150), (8, 190)]
TIERS_TWIN = [(2, 80), (3, 100), (4, 120), (6, 160)]


def _add_tiers(db: Session, hotel_id: int, type_id: int, tiers: list) -> None:
    for h, p in tiers:
        db.add(HourlyRate(room_type_id=type_id, hotel_id=hotel_id, hours=h, price=p))


def backfill_hourly_tiers(db: Session) -> None:
    """存量库一次性回填：有 hourly_price>0 且尚无档位的房型，按 [2,3,4,6,8] 各折算一档（幂等）。

    hourly_price 列保留（兼容展示兜底），业务判断一律走档位表；此函数在 main.lifespan
    ensure_seed 之后对全部房型跑一遍，存量演示库下次启动自动多档化。
    """
    types = db.query(RoomType).filter(RoomType.hourly_price > 0).all()
    for t in types:
        has = db.query(HourlyRate).filter(HourlyRate.room_type_id == t.id).first()
        if has:
            continue
        for h in (2, 3, 4, 6, 8):
            db.add(HourlyRate(room_type_id=t.id, hotel_id=t.hotel_id, hours=h, price=t.hourly_price * h))
    if types:
        db.flush()


def ensure_seed(db: Session) -> None:
    if db.query(User).first():
        return  # 已有数据

    # ---------- 酒店 ----------
    hx = Hotel(name="云栖酒店 · 西湖店", city="杭州", address="西湖区龙井路 88 号", contact_name="王琳")
    hm = Hotel(name="云栖酒店 · 莫干山店", city="湖州", address="德清县莫干山镇 12 号", contact_name="徐敏")
    hq = Hotel(name="云栖酒店 · 千岛湖店", city="杭州", address="淳安县千岛湖镇 6 号", contact_name="")
    hq.is_active = False
    db.add_all([hx, hm, hq])
    db.flush()

    # ---------- 用户 ----------
    # admin 初始密码可由 ADMIN_PASSWORD 覆盖（生产部署）；DEMO_ACCOUNTS=off 时演示员工建成停用态
    _demo_active = config.DEMO_ACCOUNTS_ENABLED
    users = [
        User(hotel_id=None, username="admin", password_hash=hash_password(config.ADMIN_PASSWORD), name="平台管理员", role="platform_admin"),
        User(hotel_id=hx.id, username="wanglin", password_hash=hash_password("123456"), name="王琳", role="admin", is_active=_demo_active),
        User(hotel_id=hx.id, username="zhouqi", password_hash=hash_password("123456"), name="周琪", role="receptionist", is_active=_demo_active),
        User(hotel_id=hx.id, username="chenlu", password_hash=hash_password("123456"), name="陈露", role="receptionist", is_active=_demo_active),
        User(hotel_id=hx.id, username="zhanggf", password_hash=hash_password("123456"), name="张桂芳", role="housekeeper", is_active=_demo_active),
        User(hotel_id=hx.id, username="liuhb", password_hash=hash_password("123456"), name="刘红燕", role="housekeeper", is_active=False),
        User(hotel_id=hm.id, username="xumin", password_hash=hash_password("123456"), name="徐敏", role="admin", is_active=_demo_active),
        User(hotel_id=hm.id, username="wufeng", password_hash=hash_password("123456"), name="吴峰", role="receptionist", is_active=_demo_active),
    ]
    db.add_all(users)
    db.flush()
    u_platform, u_lin, u_qi, u_lu, u_zhang, _, _, _ = users

    # ---------- 渠道（每店同套配置） ----------
    channel_defs = [
        ("前台（自来客）", "#1E7B3C", 1),
        ("携程", "#2F7CF6", 2),
        ("美团", "#F7B500", 3),
        ("微信小程序", "#34C759", 4),
        ("官网", "#AF52DE", 5),
        ("电话", "#FF9500", 6),
    ]
    ch_map: dict[int, dict[str, Channel]] = {}
    for h in (hx, hm, hq):
        m = {}
        for name, color, sort in channel_defs:
            c = Channel(hotel_id=h.id, name=name, color=color, sort_order=sort)
            db.add(c)
            db.flush()
            m[name] = c
        ch_map[h.id] = m

    # ---------- 房型 ----------
    def add_types(h):
        defs = [("大床房", 480, 45, 2, "1.8m 大床 · 城景", TIERS_BIG), ("双床房", 580, 55, 2, "1.2m 双床 · 城景", TIERS_TWIN),
                ("观景大床房", 780, 0, 2, "2m 大床 · 湖景阳台", []), ("湖景套房", 1280, 0, 4, "客厅 + 卧室 · 湖景", []),
                ("亲子房", 680, 0, 3, "大床 + 儿童床 · 主题布置", [])]
        out = {}
        for name, price, hourly, cap, desc, tiers in defs:
            t = RoomType(hotel_id=h.id, name=name, base_price=price, hourly_price=hourly,
                         capacity=cap, description=desc)
            db.add(t)
            db.flush()
            if tiers:
                _add_tiers(db, h.id, t.id, tiers)
            out[name] = t
        return out

    types_x = add_types(hx)

    # ---------- 客房（西湖店 38 间，与设计稿一致） ----------
    def add_room(hotel, tname, number, floor, status="vacant_clean", notes=""):
        r = Room(hotel_id=hotel.id, room_type_id=types_x[tname].id if hotel is hx else None,
                 room_number=number, floor=floor, status=status, notes=notes)
        if hotel is not hx:
            r.room_type_id = None  # 占位，稍后按店设置
        db.add(r)
        return r

    rooms_x = []
    plan = [
        # (房型, 起始, 数量, 楼层)
        ("大床房", 201, 6, 2), ("双床房", 207, 4, 2),
        ("大床房", 301, 4, 3), ("双床房", 305, 4, 3), ("亲子房", 309, 2, 3),
        ("大床房", 401, 4, 4), ("双床房", 405, 2, 4), ("观景大床房", 407, 4, 4),
        ("湖景套房", 501, 4, 5), ("观景大床房", 505, 4, 5),
    ]
    for tname, start, count, floor in plan:
        for i in range(count):
            rooms_x.append(add_room(hx, tname, str(start + i), floor))
    db.flush()
    room_by_no = {r.room_number: r for r in rooms_x}

    # 房态：在住 / 空脏（维修功能已下线，不再产生维修房）
    occupied_nos = {"201", "202", "203", "205", "206", "207", "209", "301", "302", "304", "305",
                    "308", "309", "401", "402", "404", "406", "408", "502", "504", "506", "507"}
    dirty_nos = {"204", "208", "303", "403", "501"}
    for r in rooms_x:
        if r.room_number in occupied_nos:
            r.status = "occupied"
        elif r.room_number in dirty_nos:
            r.status = "vacant_dirty"
        else:
            r.status = "vacant_clean"

    # 其他两店的房型与客房（简洁布局）
    for h, (big, twin, base_floor) in ((hm, (13, 13, 2)), (hq, (21, 21, 2))):
        tmap = {}
        for name, price, hourly, cap, tiers in (("大床房", 480, 45, 2, TIERS_BIG), ("双床房", 580, 55, 2, TIERS_TWIN)):
            t = RoomType(hotel_id=h.id, name=name, base_price=price, hourly_price=hourly,
                         capacity=cap, description="")
            db.add(t)
            db.flush()
            if tiers:
                _add_tiers(db, h.id, t.id, tiers)
            tmap[name] = t
        for i in range(big):
            db.add(Room(hotel_id=h.id, room_type_id=tmap["大床房"].id,
                        room_number=f"{base_floor}{201 + i:02d}", floor=base_floor))
        for i in range(twin):
            db.add(Room(hotel_id=h.id, room_type_id=tmap["双床房"].id,
                        room_number=f"{base_floor + 1}{201 + i:02d}", floor=base_floor + 1))

    # ---------- 客人（西湖店） ----------
    guest_defs = [
        ("李强", "13712340001", "VIP·银"), ("蒋涛", "13712340002", ""),
        ("周婷", "13612340003", "VIP·银"), ("曾丽", "13512340004", ""),
        ("王勇", "13512340005", ""), ("吴昊", "17712340006", ""),
        ("赵磊", "18812340007", ""), ("朱琳", "15012340008", ""),
        ("陈晨", "15112340009", ""), ("马俊", "13812340010", ""),
        ("彭飞", "13912340011", ""), ("杜鹃", "15612340012", ""),
        ("许娜", "13312340013", ""), ("王芳", "13812342689", "VIP·金"),
        ("方圆", "15812340014", ""), ("秦朗", "15712340015", ""),
        ("金晨", "18612340016", ""), ("孙悦", "13512349910", "VIP·黑金"),
        ("何军", "13012348834", ""), ("宋雨", "13412340017", ""),
        ("邓超", "13912340018", ""), ("范琳", "13712340019", ""),
        ("王琳", "13912340020", ""), ("沈涛", "13712340021", ""),
        ("高媛", "13112345502", ""), ("罗静", "13612349907", ""),
        ("刘洋", "13712340452", ""), ("徐丽", "13312347781", ""),
        ("张敏", "15912348877", ""), ("周成", "13912340022", ""),
    ]
    g_map = {}
    for i, (name, phone, vip) in enumerate(guest_defs):
        # 18 位模拟证件号（确定性生成仅供演示；列表/抽屉均明文展示，真实号码由前台录入）；
        # 落库即静态加密（security.encrypt_field），库泄露不可读
        id_no = (f"330106{1955 + (i % 40):04d}{(i % 12) + 1:02d}"
                 f"{(i % 28) + 1:02d}{i % 900 + 100:03d}{i % 10}")
        g = Guest(hotel_id=hx.id, name=name, phone=phone, id_number=encrypt_field(id_no))
        g.vip_level = vip
        db.add(g)
        db.flush()
        g_map[name] = g

    ch = ch_map[hx.id]
    lin = ch_map[hx.id]

    # ---------- 预订 + 账目 + 收款 ----------
    T = _d(0)

    def add_res(gname, room_no, cin_off, cout_off, chname, status="checked_in",
                extras=None, deposit=0, rate=None, created_by=u_qi, code_day=None,
                created_days_ago=3):
        room = room_by_no[room_no]
        rt = types_x[[k for k, v in types_x.items() if v.id == room.room_type_id][0]]
        cin, cout = _d(cin_off), _d(cout_off)
        nights = (cout - cin).days
        use_rate = rate if rate is not None else rt.base_price
        r = Reservation(
            hotel_id=hx.id, code="TMP" + uuid.uuid4().hex[:10],
            guest_id=g_map[gname].id, room_type_id=room.room_type_id, room_id=room.id,
            check_in=cin, check_out=cout, status=status,
            channel_id=ch[chname].id, rate=use_rate,
            created_by=created_by.id,
            created_at=_dt(cin_off, 12, 0),
        )
        db.add(r)
        db.flush()
        # 正式预订号：日期 + 真实 id，保证唯一
        r.code = f"YQ{cin:%Y%m%d}{r.id:04d}"
        # 房费
        db.add(FolioItem(hotel_id=hx.id, reservation_id=r.id, category="room_charge",
                         description=f"房费 · {nights} 晚 × ¥{use_rate}",
                         amount=nights * use_rate, created_by=created_by.id,
                         created_at=_dt(cin_off, 12, 5)))
        if extras:
            for desc, amount, cat_off in extras:
                db.add(FolioItem(hotel_id=hx.id, reservation_id=r.id, category="other",
                                 description=desc, amount=amount, created_by=created_by.id,
                                 created_at=_dt(cat_off, 12, 30)))
        if deposit:
            db.add(Payment(hotel_id=hx.id, reservation_id=r.id, method="wechat",
                           amount=deposit, created_by=created_by.id,
                           created_at=_dt(cin_off, 12, 10)))
        return r

    res_list = []
    res_list.append(add_res("李强", "201", -2, 2, "美团", deposit=1920))
    res_list.append(add_res("蒋涛", "202", -2, 0, "美团", deposit=1160))
    res_list.append(add_res("周婷", "203", -2, 1, "携程", deposit=1440))
    res_list.append(add_res("曾丽", "205", -2, 0, "官网", deposit=960))
    res_list.append(add_res("王勇", "206", -1, 2, "美团", deposit=1440))
    res_list.append(add_res("吴昊", "207", -1, 2, "电话", deposit=1740))
    res_list.append(add_res("赵磊", "209", 0, 1, "前台（自来客）", deposit=1000))
    res_list.append(add_res("朱琳", "302", 0, 3, "美团", deposit=1440))
    res_list.append(add_res("陈晨", "304", -2, 2, "携程", deposit=1500))
    res_list.append(add_res("杜鹃", "309", 0, 3, "微信小程序", deposit=2040))
    res_list.append(add_res("许娜", "401", -2, 0, "官网", deposit=960))
    r_wangfang = add_res("王芳", "402", -2, 1, "携程", deposit=900,
                         extras=[("迷你吧 · 饮料", 32, -1)])
    res_list.append(r_wangfang)
    res_list.append(add_res("方圆", "404", -1, 4, "美团", deposit=3900))
    res_list.append(add_res("秦朗", "406", 0, 2, "微信小程序", deposit=1560))
    res_list.append(add_res("金晨", "408", -2, 1, "美团", deposit=1200))
    r_hejun = add_res("何军", "502", -3, 0, "前台（自来客）", deposit=2000,
                      extras=[("迷你吧 · 饮料 2 份", 58, -1), ("洗衣服务", 40, -2)])
    res_list.append(r_hejun)
    res_list.append(add_res("宋雨", "504", 0, 3, "美团", deposit=3840))
    res_list.append(add_res("邓超", "506", -2, 0, "携程", deposit=1560))
    res_list.append(add_res("范琳", "507", -1, 2, "电话", deposit=2340))

    res_list.append(add_res("孙悦", "410", 1, 4, "官网", status="confirmed", created_by=u_lin, created_days_ago=0))
    res_list.append(add_res("王琳", "209", 1, 3, "微信小程序", status="confirmed"))
    res_list.append(add_res("沈涛", "306", 1, 4, "前台（自来客）", status="confirmed"))
    res_list.append(add_res("罗静", "409", 1, 4, "官网", status="confirmed", created_by=u_lin, created_days_ago=0))

    # 按房型预订（未锁房）：待确认
    def add_type_res(gname, tname, cin_off, cout_off, status, created_by=u_qi):
        cin, cout = _d(cin_off), _d(cout_off)
        nights = (cout - cin).days
        rt = types_x[tname]
        r = Reservation(
            hotel_id=hx.id, code="TMP" + uuid.uuid4().hex[:10],
            guest_id=g_map[gname].id, room_type_id=rt.id, room_id=None,
            check_in=cin, check_out=cout, status=status,
            channel_id=ch["电话"].id, rate=rt.base_price,
            created_by=created_by.id, created_at=_dt(cin_off, 9, 21),
        )
        db.add(r)
        db.flush()
        r.code = f"YQ{cin:%Y%m%d}{r.id:04d}"
        db.add(FolioItem(hotel_id=hx.id, reservation_id=r.id, category="room_charge",
                         description=f"房费 · {nights} 晚 × ¥{rt.base_price}",
                         amount=nights * rt.base_price, created_by=created_by.id,
                         created_at=_dt(cin_off, 9, 25)))
        return r

    add_type_res("刘洋", "双床房", 0, 3, "pending")
    add_type_res("徐丽", "亲子房", 1, 3, "pending")

    # 已离店：高媛（原订今日离店，今日下午提前退房——灰块截断 + 尾段「可售」演示样例）
    r_gaoyuan = add_res("高媛", "208", -3, 1, "美团", status="checked_out", deposit=0)
    r_gaoyuan.actual_check_out = _d(0)
    # 提前退房按实住 2 晚结算：改写原房费行（add_res 的 folio 尚未 flush，先 flush 再查）
    db.flush()
    f_gaoyuan = db.query(FolioItem).filter(
        FolioItem.reservation_id == r_gaoyuan.id, FolioItem.category == "room_charge").first()
    f_gaoyuan.amount = 2 * 580
    f_gaoyuan.description = "房费 · 2 晚 × ¥580（提前退房按实住结算）"
    db.add(Payment(hotel_id=hx.id, reservation_id=r_gaoyuan.id, method="wechat",
                   amount=2 * 580, created_by=u_qi.id, created_at=_dt(0, 11, 32)))

    # ---------- 钟点房到时提醒演示单（2026-11-23） ----------
    # 两笔今天入住的钟点房：305 未到时（在住蓝）+ 301 已超时约 20 分钟（网格红块 +
    # 右下角提醒卡演示）。入住时刻相对 now 回溯——任何时候种库都稳定成立。
    # 口径同 create_reservation：rate = 每小时单价（档位总价 ÷ 小时数），账目 = hours × rate。
    def add_hourly_res(gname, room_no, hours, checked_in_minutes_ago, overdue=False):
        room = room_by_no[room_no]
        rt = types_x[[k for k, v in types_x.items() if v.id == room.room_type_id][0]]
        tiers = {t.hours: t.price for t in db.query(HourlyRate).filter(HourlyRate.room_type_id == rt.id).all()}
        unit = money((tiers[hours] if hours in tiers else max(tiers.values())) / hours)
        cin_at = datetime.now() - timedelta(minutes=checked_in_minutes_ago)
        r = Reservation(
            hotel_id=hx.id, code="TMP" + uuid.uuid4().hex[:10],
            guest_id=g_map[gname].id, room_type_id=room.room_type_id, room_id=room.id,
            check_in=_d(0), check_out=_d(1), status="checked_in",
            channel_id=ch["美团"].id, rate=unit, stay_type="hourly", hours=hours,
            created_by=u_qi.id, created_at=cin_at, actual_check_in=cin_at,
        )
        db.add(r)
        db.flush()
        r.code = f"YQ{_d(0):%Y%m%d}{r.id:04d}"
        db.add(FolioItem(hotel_id=hx.id, reservation_id=r.id, category="room_charge",
                         description=f"钟点房费 · {hours} 小时 × ¥{fmt_money(unit)}",
                         amount=money(hours * unit), created_by=u_qi.id, created_at=cin_at))
        db.add(OperationLog(hotel_id=hx.id, user_id=u_qi.id, operator_name=u_qi.name,
                            action="check_in", object_type="reservation", object_id=r.id,
                            summary=f"办理入住 {gname} · {r.code} · 分配 {room_no} {rt.name}",
                            created_at=cin_at))
        return r

    r_ot_in = add_hourly_res("马俊", "305", 3, checked_in_minutes_ago=60)     # 3h 档，1h 前入住 → 还有 2h
    r_ot_over = add_hourly_res("张敏", "301", 2, checked_in_minutes_ago=140, overdue=True)  # 2h 档，140 分前入住 → 超时 20 分
    r_ot_over2 = add_hourly_res("彭飞", "308", 2, checked_in_minutes_ago=95)  # 2h 档，95 分前入住 → 超时 15 分
    # 305 结清（不欠款）；301 未结清 → 提醒卡「欠款」栏与网格「欠」徽章的演示数据
    db.add(Payment(hotel_id=hx.id, reservation_id=r_ot_in.id, method="wechat",
                   amount=money(r_ot_in.hours * r_ot_in.rate), created_by=u_qi.id,
                   created_at=datetime.now() - timedelta(minutes=55)))
    db.add(Payment(hotel_id=hx.id, reservation_id=r_ot_over2.id, method="cash",
                   amount=money(r_ot_over2.hours * r_ot_over2.rate), created_by=u_qi.id,
                   created_at=datetime.now() - timedelta(minutes=90)))

    # ---------- 今日操作日志（单日明细演示） ----------
    logs = [
        (9, 5, u_qi, "check_in", "reservation", "办理入住 赵磊 · 209 大床房 · 押金 ¥1,000"),
        (9, 21, u_qi, "reservation_confirm", "reservation", "电话确认 刘洋 · 双床房 11/18 – 11/21"),
        (10, 47, u_lin, "reservation_create", "reservation", "创建预订 孙悦 · 410 观景大床房 · 11/19 – 11/22"),
        (11, 32, u_qi, "payment", "payment", "收款 ¥1,160 · 高媛 · 微信 · 提前退房按实住 2 晚结清"),
        (16, 0, u_qi, "check_out", "reservation", "退房结算 高媛 · 208 · 提前退房（原订至明日）· 结清 · 房态转空脏"),
        (12, 20, u_zhang, "room_status", "room", "客房 301 · 房态→空净"),
        (15, 2, u_zhang, "room_status", "room", "客房 407 · 房态→空净"),
        (16, 40, u_qi, "folio_add", "reservation", "加收杂费 迷你吧 ¥32 · 402 王芳"),
        (17, 30, u_lin, "reservation_create", "reservation", "创建预订 罗静 · 409 观景大床房 · 11/19 – 11/22"),
    ]
    for hh, mm, u, action, otype, summary in logs:
        db.add(OperationLog(hotel_id=hx.id, user_id=u.id, operator_name=u.name,
                            action=action, object_type=otype, summary=summary,
                            created_at=_dt(0, hh, mm)))

    db.commit()
