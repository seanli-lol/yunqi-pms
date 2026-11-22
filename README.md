# 云栖 PMS — 酒店前台管理系统

单体酒店 PMS，支持多酒店数据隔离。Apple 式简约设计（阶段一设计稿 1:1 实现），Web + 移动端响应式（一套代码）。

## 技术栈

| 端 | 技术 |
|---|---|
| 后端 | Python 3.10+ · FastAPI · SQLAlchemy 2.0 · MySQL 8.4（docker-compose 跑库，无 Docker 缺省回落 SQLite）· JWT（PyJWT + PBKDF2） |
| 前端 | Vite · React 18 · TypeScript · Tailwind CSS v4 · React Router · TanStack Query · Recharts · Lucide |

## 功能总览

- **多店隔离**：`hotels` 表挂全局，所有业务表带 `hotel_id`；员工按「酒店 + 账号 + 密码」登录，只能访问本店数据；平台管理员（不选酒店）登录后可新增酒店、跨店配置员工
- **房态盘**：日历时间轴视图（默认，14 天跨天预订色块 + 来源颜色竖条 + 「欠」标 + 可售余量）与单日网格视图切换；**拖动方块换房/改期（冲突自动回弹）**；**点击空白格直接开单**（预填房号与日期）
- **来源渠道**：每店可配置渠道名称、颜色（预订方块最前端的竖条）、展示顺序；颜色实时生效于日历、列表与下拉
- **预订**：按房型（自动校验可售量）或锁定房号创建；确认/取消；拖动改期
- **前台**：抵店/在住/离店三场景；入住向导（空净房选房 + 押金）；延住；退房结算（未结清拦截 + 强制退房）
- **账务**：房费自动入账、杂费加收、押金/收款记录；未结清一目了然
- **客房清洁**：任务看板（待清洁/进行中/已完成）；退房自动生成任务；完成自动转空净
- **客户档案**：住客资料、会员等级、历史入住
- **经营报表**：预设（近 7 天/30 天/本月）+ **自定义时间范围**；入住率/ADR/RevPAR/营收趋势图；**单日经营明细 + 当日操作记录（谁在何时做了什么）**
- **操作留痕**：预订、入住、退房、收款、清洁等关键动作全部记录操作人

## 启动

```bash
# 后端（端口 8000；首次启动自动建库 + 灌入演示数据）
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000

# 前端（端口 5173，/api 自动代理到 8000）
cd frontend
npm install
npm run dev
```

打开 http://localhost:5173

**演示账号**（密码均为 `123456`）：

| 角色 | 登录方式 |
|---|---|
| 前台员工 | 酒店选「云栖酒店 · 西湖店」+ 账号 `zhouqi` |
| 酒店管理员 | 酒店选「云栖酒店 · 西湖店」+ 账号 `wanglin` |
| 平台管理员 | 切换到「平台管理员」+ 账号 `admin`（无需选酒店） |

其他员工：`chenlu`（前台）、`zhanggf`（客房部）、`xumin`/`wufeng`（莫干山店）。

## Docker 一键部署（服务器）

```bash
git clone <本仓库> && cd my-hotel-pms

# 生产建议：仓库根目录建 .env 覆盖密钥（compose 自动读取并注入容器）
#   JWT_SECRET=<强随机值>
#   DATA_SECRET_KEY=<强随机值>     # 证件号加密密钥：一旦有数据上盘，此后【不可更换】
docker compose up -d --build      # 起 MySQL + 后端 + 前端(nginx) 三容器，等 docker compose ps 全部 healthy
```

- 访问 `http://<服务器IP>:8080`（端口用 `PMS_PORT` 覆盖）；更新代码后重复 `docker compose up -d --build`
- 登录验证码默认开启（`CAPTCHA=on`）；首次启动自动建库 + 灌入演示数据（lifespan 幂等，重启容器不重复）
- 数据在 named volume `mysql-data`；清库重来 `docker compose down -v`
- MySQL 只绑定宿主机 `127.0.0.1:3306` 不暴露公网；本地开发仍用 `docker compose up -d mysql` 只起库，后端/前端照旧在宿主机跑

## 测试

```bash
cd backend
.venv/bin/python -m pytest tests/test_smoke.py -q
```

覆盖：双模式登录与酒店校验、房态盘聚合、直接预订 + 同时段冲突（409）、拖动改期、
「空脏不可入住 → 清洁完成 → 入住 → 未结清拦截 → 强制退房 → 自动生成清洁任务」全链路、多店数据隔离、渠道颜色配置、报表单日明细。

## 设计稿

阶段一的高保真静态原型保留在 `design/prototype/`（`python3 -m http.server 4321` 浏览），
设计令牌单一来源 `design/prototype/tokens.css + components.css` 已 1:1 移植到前端 `src/index.css`。

## 主要目录

```
backend/app/
  models.py        # 11 张表（hotels/users/channels/room_types/rooms/guests/
                   #  reservations/folio_items/payments/housekeeping_tasks/operation_logs）
  routers/         # auth · hotels(+users) · channels · rooms(+board) ·
                   # reservations(+folio) · guests · housekeeping · reports(+dashboard)
  seed.py          # 演示数据（日期相对今天，与设计稿一致）
  security.py      # PBKDF2 密码哈希 + JWT
frontend/src/
  pages/           # Login · Dashboard · Rooms(日历/网格) · Reservations · FrontDesk
                   # · Billing · Guests · Housekeeping · Reports · Settings
  api.ts           # fetch 封装（自动注入 JWT 与 hotel_id 上下文）
```

## 生产部署提示

- 容器化全栈部署见上文「Docker 一键部署」；无 Docker 本地跑时数据库缺省回落本地 SQLite
- `JWT_SECRET` / `DATA_SECRET_KEY` 通过根目录 `.env`（compose 插值）或环境变量覆盖；PBKDF2 迭代次数可按需提升
- 建议启用 HTTPS、增加账号首次登录改密、备份策略
