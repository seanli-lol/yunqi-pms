# 酒店 PMS 管理系统 — 实施计划（设计先行 · 定时启动）

## Context（背景与目标）

在空目录 `/path/to/yunqi-pms` 从零搭建单体酒店 PMS。**完整版功能**（仪表盘、房态盘、预订、入住/退房、账务、客房清洁、客户档案、经营报表、系统设置）、**简体中文界面**、**Apple 官网式简约风格**、Web + 移动端（响应式一套代码）、后端 Python + SQLite，前端技术栈由我决定。

**流程分两个阶段：先做 UI 设计，经你确认通过后，才开始编写代码。**

## ⏰ 启动方式（计划批准后我做的第一件事）

- 批准本计划后，我**立即创建一次性定时任务**（不立即动工）：**今晚 23:05（2026-11-17）自动开始执行阶段一 UI 设计**
- 定时任务自包含完整计划内容（新会话可独立执行）；23:05 的运行只做阶段一，完成原型后在检查点停止并输出可浏览链接与截图，**等待你审阅**
- 你审阅原型并确认通过后，再继续阶段二（可直接对话继续，或另约定时间）

## 技术栈（代码阶段使用，已定）

- **后端**：FastAPI + SQLAlchemy 2.0（同步）+ Pydantic v2 + SQLite；JWT 认证（pyjwt + bcrypt）；角色 admin / receptionist / housekeeper；`seed.py` 演示数据
- **前端**：Vite + React 18 + TypeScript + Tailwind CSS v4 + React Router + TanStack Query + Recharts + Lucide；移动端为响应式布局（桌面侧栏 → 窄屏底部 Tab，表格转卡片）
- 环境前提：Python 3.10+ / Node 18+（运行时先确认版本）

## 设计系统（Apple 式简约）

- 运行 `ui-ux-pro-max` 的 `--design-system` 搜索（hotel pms dashboard minimal）并 `--persist` 到 `design-system/`，结合 frontend-design 技能流程落地
- **色彩**：背景 `#FFFFFF` / `#F5F5F7`；正文 `#1D1D1F` / 次级 `#6E6E73`；主色 Apple 蓝 `#0071E3`；发丝线 `#D2D2D7`；语义色用 iOS 系统色（绿 `#34C759`、橙 `#FF9500`、红 `#FF3B30`），房态用同色系浅底色块 + 图例
- **字体**：`-apple-system, "SF Pro Text", "PingFang SC"`；基础 15–17px，大标题 28–34px semibold 收紧字距
- **形态**：卡片 18px 圆角、发丝边框、极淡阴影；主按钮胶囊形；大留白；动效克制（0.2–0.3s，尊重 prefers-reduced-motion）

---

## 阶段一：UI 设计（不写任何业务代码）

**交付物：可在浏览器中点击浏览的高保真静态原型**，放在 `design/prototype/`：

- `tokens.css` + `components.css`：设计令牌与组件样式的单一来源（编码阶段直接复用）
- 10 个页面的静态 HTML（内置假数据，无需后端）：index 导航页、登录、仪表盘、房态盘（含房间详情弹层）、预订列表（含新建对话框）、前台工作台（三 Tab + 入住/退房向导）、账务（含收款抽屉）、客户档案、清洁看板、经营报表、系统设置
- `mobile.html` — 核心界面按 390px 宽置于手机框内展示底部 Tab（≤5 个）与卡片化表格；所有页面本身响应式，缩窄浏览器即可验证
- `python3 -m http.server` 起本地静态服务，输出可点击浏览的链接

**⛔ 检查点：暂停，等待你在浏览器中审阅并提出修改意见；迭代直至你确认「UI 设计通过」。未通过前不进入阶段二。**

---

## 阶段二：代码实现（仅在 UI 设计通过后开始）

1. **后端**：8 张表（users / room_types / rooms / guests / reservations / folio_items / payments / housekeeping_tasks）+ 认证 + REST 路由（`/api` 前缀，含 `GET /rooms/board`、`check-in` / `check-out`）+ seed + pytest 冒烟测试（建订/入住/退房/账务状态机）
   - 业务规则：建预订按房型日期重叠校验；入住必须分配"空净"房；退房自动置"空脏"并生成清洁任务，清洁完成转"空净"；退房未结清账款给确认提示；维修房不可分配
2. **前端**：Vite + React 脚手架，将通过的设计令牌接入 Tailwind v4 主题，按设计稿逐页实现；AppShell 响应式布局 + 路由守卫；加载/空/错误态打磨
3. **收尾**：可访问性检查（对比度 ≥4.5:1、焦点可见、44px 触控目标）、README 启动说明

## 验证

- 阶段一：本地静态服务可浏览全部原型；交给你前先用浏览器自动化自查截图（1440px + 390px）
- 阶段二：后端 :8000 + 前端 :5173；浏览器自动化走通真实流程（登录 → 建预订 → 入住 → 加收杂费 → 清洁完成转空净 → 退房结算）；移动视口复查无横向滚动；pytest 通过