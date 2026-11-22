<div align="center">

# 云栖 PMS · 酒店前台管理系统

**单体酒店 PMS，支持多酒店数据隔离 · Apple 式简约设计 · 桌面 / 移动端自适应**

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm--NC--1.0.0-blue)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.14-3776AB?logo=python&logoColor=white)](backend/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)](frontend/)
[![MySQL](https://img.shields.io/badge/MySQL-8.4-4479A1?logo=mysql&logoColor=white)](docker-compose.yml)
[![Docker](https://img.shields.io/badge/deploy-docker%20compose-2496ED?logo=docker&logoColor=white)](#方式一docker-一键部署推荐)

![房态盘 · 日历时间轴](screenshots/deploy-rooms-light.png)

</div>

---

## 功能总览

**多店隔离与角色**

- 所有业务表带 `hotel_id`；员工按「酒店 + 账号 + 密码」登录，只能访问本店数据；平台管理员不选酒店，可跨店新增酒店、配置员工、切换店铺
- 关键动作（预订/入住/退房/收款/改价/删款……）全部写操作日志，报表可直接查「谁在何时做了什么」

**房态盘（核心工作台）**

- 14 天日历时间轴 + 单日网格双视图；点击空白格或**拖选多天**直接开单（可一次累积多间房）
- **拖动方块**换房/改期，冲突自动回弹；同房重叠预订自动上下分轨
- 钟点房 / 当日往返退房聚合为格角「退房」角标，悬停 / 点按展开明细浮卡
- 「欠」（未结清）/「超」（多收待退）金额徽章；提前退房自动截断存根、**尾部时段直接续售**
- 净房 / 脏房一键切换；来源渠道颜色竖条实时生效于方块

**预订与前台**

- 按房型（自动校验可售量）或锁定房号创建；`pending → confirmed → checked_in → checked_out` 状态机
- 撤销入住 / 撤销退房（带冲突校验）；未来抵店的预订只可确认，不可提前入住
- 钟点房：房型配置钟点价后方可按小时售卖（未配价强校验拦截），延住按小时累计
- 脏房 / 前客未退可放宽入住（自动留痕）；退房未结清拦截 + 强制退房二次确认

**账务**

- 金额一律整数（元），房费自动入账；收款方式每店可配置（现金 / 微信 / 支付宝 / 银行卡 + 自定义）
- 订单详情抽屉：应收 / 实收 / 未结三栏、房卡信息、折叠账目、收款按笔删除、「＋收款」支持备注、更正实收
- 延住追加账目行，不重复计算原房费

**客户档案**

- 姓名 / 手机号 / 证件号 / 备注全量管理；同店手机号与证件号查重，跨店同号放行
- **证件号 AES-256-GCM 加密落库**，操作日志摘要自动掩码
- 预订录入客人姓名自动联想，选中直接带出老档案（手机号自动复用，避免重复建档）

**经营报表**

- 近 7 天 / 30 天 / 本月预设 + 自定义区间；入住率 / ADR / RevPAR / 营收趋势图（深浅主题自适应）

**系统设置**

- 酒店管理（营业 / 筹备开关，筹备中不在登录页出现）、客房（编辑 / 删除守卫）、房型（含钟点价）、员工账号、渠道、收款方式

**体验与安全**

- 浅色 / 深色 / 跟随系统三态主题，颜色全量令牌化；桌面侧栏 + 移动端底部 Tab，一套代码自适应
- 滑块验证码（可开关）、PBKDF2 密码哈希、JWT + 刷新令牌轮换（60s 宽限 + 泄露检测）、登录限流

## 技术栈

| 端 | 技术 |
|---|---|
| 后端 | Python 3.14 · FastAPI · SQLAlchemy 2.0 · MySQL 8.4（PyMySQL 驱动，无 Docker 缺省回落 SQLite）· PyJWT（密码 PBKDF2） |
| 前端 | Vite 6 · React 18 · TypeScript · Tailwind CSS v4 · React Router 6 · TanStack Query 5 · Recharts · lucide-react |
| 部署 | Docker Compose 三容器（MySQL + FastAPI + nginx），一键构建、健康检查、自动建库种子 |

![深色主题](screenshots/deploy-rooms-dark.png)

## 快速开始

### 方式一：Docker 一键部署（推荐）

```bash
git clone https://github.com/seanli-lol/yunqi-pms.git && cd yunqi-pms

# 生产建议：在仓库根目录建 .env 覆盖密钥（compose 自动读取并注入容器，见下方环境变量表）
docker compose up -d --build      # 起 MySQL + 后端 + 前端(nginx) 三容器

docker compose ps                 # 等全部 healthy
```

- 访问 `http://<服务器IP>:8080`（端口用 `PMS_PORT` 覆盖）；更新代码后重复 `docker compose up -d --build`
- 首次启动自动建库 + 灌入演示数据（幂等，重启容器不重复）
- 数据在 named volume `mysql-data`；清库重来 `docker compose down -v`（改库名 / 账号后必须 `-v` 重建卷）
- MySQL 只绑定宿主机 `127.0.0.1:3306`，不暴露公网

### 方式二：本地开发

```bash
# 只起数据库（注意：不带服务名的 up -d 会连前后端一起起）
docker compose up -d mysql

# 后端（端口 8000；首次启动自动建库 + 灌演示数据）
cd backend
cp .env.example .env              # 本地缺省 CAPTCHA=off（不用拖滑块）、回落 SQLite
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000

# 前端（端口 5173，/api 自动代理到 8000）
cd frontend
npm install
npm run dev
```

打开 http://localhost:5173 。不装 Docker 也可以：后端不配 MySQL 参数时缺省使用本地 SQLite 文件，删掉该文件即重建演示数据。

### 演示账号（密码均为 `123456`）

| 角色 | 登录方式 |
|---|---|
| 前台员工 | 酒店选「云栖酒店 · 西湖店」+ 账号 `zhouqi` |
| 酒店管理员 | 酒店选「云栖酒店 · 西湖店」+ 账号 `wanglin` |
| 平台管理员 | 切换到「平台管理员」+ 账号 `admin`（无需选酒店） |

其他员工：`chenlu`（西湖店前台）、`xumin` / `wufeng`（莫干山店）。生产部署可用 `DEMO_ACCOUNTS=off` 停用演示账号、`ADMIN_PASSWORD` 设定 admin 初始密码。

## 环境变量

**Docker 部署**（写在仓库根目录 `.env`，compose 插值注入，均有缺省值）：

| 变量 | 缺省 | 说明 |
|---|---|---|
| `JWT_SECRET` | dev 演示值 | JWT 签名密钥，**生产必须换**（如 `python -c "import secrets;print(secrets.token_urlsafe(48))"`） |
| `DATA_SECRET_KEY` | dev 演示值 | 证件号加密密钥，**生产必须覆盖；一旦有数据上盘不可更换**（换钥 = 存量密文全部无法解密） |
| `ADMIN_PASSWORD` | `123456` | admin 初始密码（仅首次建库生效；存量库改密需改数据） |
| `DEMO_ACCOUNTS` | `on` | `off` 时演示员工账号建成停用态（生产推荐） |
| `CAPTCHA` | `on` | 登录滑块验证码开关 |
| `VITE_DEMO_HINT` | `on` | `off` 时登录页不显示演示账号提示（随前端构建固化） |
| `PMS_PORT` | `8080` | 门户端口 |
| `MYSQL_ROOT_PASSWORD` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `pms123456` / `pms` / `pms123456` / `pms` | 数据库凭据（演示值，生产替换；仅首次建卷生效） |
| `PIP_INDEX_URL` / `NPM_REGISTRY` | 官方源 | 构建期依赖源，国内服务器可换清华源 / npmmirror 加速 |

**本地开发**（`backend/.env`，模板见 `backend/.env.example`）：`CAPTCHA`、`JWT_SECRET`、`DATA_SECRET_KEY`、`DB_ENGINE`（`sqlite` 缺省 / `mysql`）。用 MySQL 时 `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` 五项必须全部显式配置，缺一启动报错。

## 测试

```bash
cd backend
.venv/bin/python -m pytest tests/test_smoke.py -q   # 22 项冒烟测试，默认走临时 SQLite
```

覆盖：双模式登录 + 滑块验证码 + 刷新令牌轮换/宽限/泄露吊销、房态盘直接预订→选房→入住→退房全链路、建订冲突（409）、拖动改期、钟点房全链路、延住、编辑登记 + 更正实收 + 撤销入住/撤销退房、取消清款、提前退房截断 + 尾部续售 + 撤销冲突、收款方式配置 + 停用拦截 + 删除保护、收款备注、多店隔离、渠道、报表、客房/酒店编辑与删除守卫、PII 加密与日志掩码。

直打 MySQL：`export DB_ENGINE=mysql` + 五项 `DB_*`（指向独立 `*_test` 空库）后跑同一套。

## 项目结构

```
backend/app/
  models.py           # 12 张表（hotels/users/channels/room_types/rooms/guests/
                      #   reservations/folio_items/payments/payment_methods/
                      #   refresh_tokens/operation_logs）
  routers/            # auth · hotels(+users) · channels · payment_methods ·
                      #   rooms(+board) · reservations(+folio) · guests · reports(+dashboard)
  seed.py             # 演示数据（日期相对今天；ADMIN_PASSWORD / DEMO_ACCOUNTS 开关）
  security.py         # PBKDF2 密码哈希 + JWT + 证件号 AES-256-GCM 加解密
  captcha.py          # 登录滑块验证码（服务端 SVG，无 Pillow 依赖）
  db.py               # 连接 / 轻量幂等迁移 / 存量加密回填
frontend/src/
  pages/              # Login · Dashboard · Rooms(日历/网格) · Reservations · FrontDesk
                      #   · Billing · Guests · Reports · Settings
  api.ts              # fetch 封装（自动注入 JWT、静默续期、hotel_id 上下文）
design/prototype/     # 高保真静态原型（视觉与交互的单一来源，见下文）
design-system/        # 设计令牌文档
```

## 设计稿（原型先行）

项目采用「先出高保真原型 → 审阅确认 → 再落业务代码」的交付流程。阶段一原型保留在
`design/prototype/`（纯 HTML/CSS/JS，可 `python3 -m http.server 4321 --directory design/prototype` 浏览，
支持 `?theme=dark` 预览深色）。

设计令牌单一来源 `design/prototype/tokens.css + components.css`，已 1:1 移植到前端 `frontend/src/index.css`——
改视觉两处保持一致。

## 生产环境安全清单

- [ ] `JWT_SECRET`、`DATA_SECRET_KEY`、`MYSQL_ROOT_PASSWORD`、`DB_PASSWORD` 换成强随机值
- [ ] `DATA_SECRET_KEY` 设定后**不可再更换**（有客人数据后换钥 = 密文全废），请妥善备份
- [ ] `ADMIN_PASSWORD` 设定初始密码；`DEMO_ACCOUNTS=off` 停用演示账号；`VITE_DEMO_HINT=off` 关闭登录页提示
- [ ] `CAPTCHA=on`（部署缺省已是 on）
- [ ] 前置 HTTPS（nginx 之上再加反代/证书）；MySQL 已只绑 `127.0.0.1`
- [ ] 制定数据库备份策略（named volume `mysql-data`）

## 许可证

本项目采用 [PolyForm Noncommercial License 1.0.0](LICENSE) 授权。

- ✅ **允许**：个人学习、科研、测试、爱好项目，以及慈善组织 / 教育机构 / 政府机构等非营利使用——可自由使用、修改、分发
- ❌ **禁止**：任何商业用途（包括公司内部经营性使用、商业部署、销售或捆绑收费）
- 💼 **商业授权**：需要商业使用请通过 [Issues](../../issues) 联系作者洽谈

> PolyForm Noncommercial 是专为软件设计的「仅非商业」许可证（Creative Commons 的 NC 系列官方不建议用于软件）。
