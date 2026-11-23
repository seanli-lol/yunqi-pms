import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  BedDouble, BellRing, CalendarDays, ChartColumn, ChevronDown, ChevronRight, Ellipsis,
  LayoutDashboard, LogOut, Monitor, Moon, ReceiptText, SlidersHorizontal, Sun, Users,
} from 'lucide-react'
import { api, type DashData, type Hotel } from './api'
import { Overlay } from './ui'
import { useAuth } from './auth'
import { useTheme, type ThemeMode } from './theme'

/** 导航项：desc 是面板里的一句话用途说明（竖排侧栏没有这一栏，面板两栏布局放得下） */
type NavItem = {
  to: string
  label: string
  desc: string
  icon: typeof LayoutDashboard
  /** 面板角标取 dashboard 的哪个字段，以及读数的量词（状态语义各家不同，不能一律「待办」） */
  badge?: { field: 'arrivals_ready' | 'pending_confirm' | 'unpaid_count'; unit: string; danger?: boolean }
}

const NAV_GROUPS: { group: string; items: NavItem[] }[] = [
  { group: '运营', items: [
    { to: '/', label: '仪表盘', desc: '今日入住率、抵离与营收', icon: LayoutDashboard },
    { to: '/rooms', label: '房态盘', desc: '按房间排期，点格开单', icon: BedDouble },
    { to: '/front-desk', label: '前台', desc: '到店入住、在住、退房', icon: BellRing,
      badge: { field: 'arrivals_ready', unit: '位可入住' } },
    { to: '/reservations', label: '预订', desc: '确认、改期、取消', icon: CalendarDays,
      badge: { field: 'pending_confirm', unit: '单待确认' } },
  ]},
  { group: '经营', items: [
    { to: '/billing', label: '账务', desc: '未结账单与收款', icon: ReceiptText,
      badge: { field: 'unpaid_count', unit: '笔未结', danger: true } },
    { to: '/guests', label: '客户', desc: '住客档案与历史', icon: Users },
    { to: '/reports', label: '经营报表', desc: '营收、出租率趋势', icon: ChartColumn },
  ]},
]
const NAV_FLAT = NAV_GROUPS.flatMap(g => g.items)

const TABS = [
  { to: '/', label: '仪表盘', icon: LayoutDashboard },
  { to: '/rooms', label: '房态盘', icon: BedDouble },
  { to: '/front-desk', label: '前台', icon: BellRing },
]

/* ---- 主题：三态定义与图标 ---- */
const THEME_OPTIONS: { key: ThemeMode; label: string; icon: typeof Sun }[] = [
  { key: 'light', label: '浅色', icon: Sun },
  { key: 'dark', label: '深色', icon: Moon },
  { key: 'system', label: '跟随系统', icon: Monitor },
]
const THEME_LABEL: Record<ThemeMode, string> = { light: '浅色', dark: '深色', system: '跟随系统' }

/** 顶栏「外观」图标按钮 + 向下弹出的三态菜单（不带文字，靠 title/aria-label 说明） */
function ThemePicker() {
  const { mode, setMode } = useTheme()
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const Icon = THEME_OPTIONS.find(o => o.key === mode)!.icon
  const label = `外观 · ${THEME_LABEL[mode]}`

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="theme-wrap" ref={wrap}>
      <button
        type="button"
        className="topbar-icon"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <Icon />
      </button>
      {open && (
        <div className="pop-menu theme-menu" role="menu">
          {THEME_OPTIONS.map(o => (
            <button
              key={o.key}
              type="button"
              role="menuitemradio"
              aria-checked={mode === o.key}
              className={mode === o.key ? 'active' : ''}
              onClick={() => { setMode(o.key); setOpen(false) }}
            >
              <o.icon />
              <span>{o.label}</span>
              <span className="tick">✓</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function MoreSheet({ open, onClose, roleLine }: { open: boolean; onClose: () => void; roleLine: string }) {
  const { mode, setMode } = useTheme()
  const { user, logout } = useAuth()
  const nav = useNavigate()
  const extras = [
    { to: '/reservations', label: '预订管理', icon: CalendarDays },
    { to: '/billing', label: '账务', icon: ReceiptText },
    { to: '/guests', label: '客户档案', icon: Users },
    { to: '/reports', label: '经营报表', icon: ChartColumn },
    { to: '/settings', label: '设置', icon: SlidersHorizontal },
  ]
  return (
    <Overlay open={open} onClose={onClose} >
      <div className="sheet-panel">
        <div className="sheet-handle" />
        {/* 账户区：窄屏顶栏隐藏，身份信息落在这里 */}
        <div className="sheet-account">
          <span className="avatar">{user?.name?.charAt(0)}</span>
          <div>
            <div className="sheet-account-name">{user?.name}</div>
            <div className="sheet-account-role">{roleLine}</div>
          </div>
        </div>
        {extras.map(x => (
          <NavLink key={x.to} to={x.to} className="sheet-link" onClick={onClose}>
            <x.icon />
            {x.label}
            <ChevronRight className="chev" />
          </NavLink>
        ))}
        {/* 移动端外观切换：与桌面端三态一致 */}
        <div className="theme-sheet">
          <span className="theme-sheet-label">外观</span>
          <div className="segmented" role="tablist">
            {THEME_OPTIONS.map(o => (
              <button
                key={o.key}
                type="button"
                role="tab"
                aria-selected={mode === o.key}
                className={mode === o.key ? 'active' : ''}
                onClick={() => setMode(o.key)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        {/* 退出：窄屏此前没有任何退出入口（侧栏被隐藏），这里补上 */}
        <button
          type="button"
          className="sheet-link sheet-danger"
          onClick={() => { onClose(); logout(); nav('/login') }}
        >
          <LogOut />
          退出登录
        </button>
      </div>
    </Overlay>
  )
}

export default function AppShell() {
  const [moreOpen, setMoreOpen] = useState(false)
  // 导航面板开合：侧栏整个退场后，全部导航（含系统设置）收在这一个入口里
  const [menuOpen, setMenuOpen] = useState(false)
  const menuWrap = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const loc = useLocation()
  const nav = useNavigate()
  const { user, activeHotelName, activeHotelId, setActiveHotel, logout } = useAuth()

  // 平台管理员可操作的酒店全列表（与设置页共用 ['hotels'] 缓存）
  const hotels = useQuery({
    queryKey: ['hotels'],
    queryFn: () => api.get<Hotel[]>('/api/hotels'),
    enabled: user?.role === 'platform_admin',
  })
  // 待办计数与仪表盘共用 ['dashboard'] 缓存，但只在菜单打开时拉取：
  // 侧栏时代外壳不发这次请求，现在也不该让每页浏览都打一次；
  // 平台管理员首次登录尚未选店时没有业务上下文，请求会被后端拒（400），一并挡掉。
  const dash = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashData>('/api/dashboard'),
    enabled: menuOpen && !!activeHotelId,
    staleTime: 30_000,
  })

  // 平台管理员尚未选店（首次登录）时与设置页同口径：自动选中第一家酒店作为业务上下文
  useEffect(() => {
    if (user?.role === 'platform_admin' && !activeHotelId && hotels.data?.length) {
      setActiveHotel(hotels.data[0].id, hotels.data[0].name)
    }
  }, [user, activeHotelId, hotels.data, setActiveHotel])
  // 角色 + 去掉「云栖酒店 · 」前缀的门店名（顶栏 title 与更多面板共用同一口径）
  const roleLine = `${user?.role_label ?? ''}${
    activeHotelName && user?.role !== 'platform_admin'
      ? ` · ${activeHotelName.replace('云栖酒店 · ', '')}`
      : ''
  }`

  // 点外部 / Esc 关闭导航面板；关闭后焦点回到触发按钮
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (!menuWrap.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setMenuOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  // 路由变化即收起面板（点面板里的链接后不留在展开态）
  useEffect(() => { setMenuOpen(false) }, [loc.pathname])

  const current = NAV_FLAT.find(it => it.to === loc.pathname)
    ?? (loc.pathname === '/settings' ? { label: '系统设置', icon: SlidersHorizontal } : null)
  const CurrentIcon = current?.icon ?? LayoutDashboard

  // 平台管理员切换酒店
  const onSwitchHotel = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = Number(e.target.value)
    const name = e.target.selectedOptions[0]?.textContent ?? ''
    setActiveHotel(id, name)
    nav(loc.pathname)
    window.location.reload()
  }

  const badgeOf = (it: NavItem) => {
    if (!it.badge || !dash.data) return null
    const n = dash.data[it.badge.field]
    if (!n) return null
    return { n, unit: it.badge.unit, danger: it.badge.danger }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <a className="brand" href="/" aria-label={`${activeHotelName ?? '云栖酒店'}，返回仪表盘`}>
            <span className="brand-mark" aria-hidden="true">云</span>
            <span className="brand-name">{activeHotelName ?? '云栖酒店'}</span>
            <span className="brand-pms">PMS</span>
          </a>

          <span className="topbar-div" aria-hidden="true" />

          {/* 左上角：当前页即菜单入口 —— 位置指示与导航开关合一 */}
          <div className="nav-menu" ref={menuWrap}>
            <button
              type="button"
              ref={triggerRef}
              className="nav-trigger"
              aria-haspopup="true"
              aria-expanded={menuOpen}
              aria-controls="navPanel"
              title="导航菜单"
              onClick={() => setMenuOpen(o => !o)}
            >
              <CurrentIcon />
              <span>{current?.label ?? '导航'}</span>
              <ChevronDown className="chev" />
            </button>

            {menuOpen && (
              <nav className="menu-panel" id="navPanel" aria-label="主导航">
                <div className="mp-head">
                  <span className="t">导航</span>
                  <span className="k"><kbd>Esc</kbd> 关闭</span>
                </div>

                {/* 平台管理员专属：切店后顶栏品牌与业务上下文同步更新 */}
                {user?.role === 'platform_admin' && (
                  <div className="mp-hotel">
                    <span className="l">门店</span>
                    <select
                      className="select"
                      value={activeHotelId ?? ''}
                      onChange={onSwitchHotel}
                      aria-label="切换酒店"
                    >
                      {hotels.data?.length
                        ? hotels.data.map(h => <option key={h.id} value={h.id}>{h.name}</option>)
                        : <option value={activeHotelId ?? ''}>{activeHotelName ?? '选择酒店'}</option>}
                    </select>
                  </div>
                )}

                <div className="mp-cols">
                  {NAV_GROUPS.map(g => (
                    <div key={g.group}>
                      <span className="mp-label">{g.group}</span>
                      {g.items.map(it => {
                        const badge = badgeOf(it)
                        return (
                          <NavLink
                            key={it.to}
                            to={it.to}
                            end={it.to === '/'}
                            className={({ isActive }) => `mp-item${isActive ? ' active' : ''}`}
                          >
                            <it.icon />
                            <span>
                              {/* 角标与标题同行：放到右侧独立列会把说明挤成两行 */}
                              <span className="mp-title">
                                <span className="tt">{it.label}</span>
                                {badge && (
                                  <span className={`mp-count${badge.danger ? ' red' : ''}`}>
                                    {badge.n} {badge.unit}
                                  </span>
                                )}
                              </span>
                              <span className="dd">{it.desc}</span>
                            </span>
                          </NavLink>
                        )
                      })}
                    </div>
                  ))}
                </div>

                <div className="mp-foot">
                  <NavLink
                    to="/settings"
                    className={({ isActive }) => (isActive ? 'active' : '')}
                  >
                    <SlidersHorizontal />
                    <span>系统设置</span>
                    <ChevronRight className="chev" />
                  </NavLink>
                </div>
              </nav>
            )}
          </div>
        </div>

        <div className="topbar-right">
          <ThemePicker />
          <span className="topbar-user" title={`${user?.name} · ${roleLine}`}>
            <span className="avatar">{user?.name?.charAt(0)}</span>
            <span className="name">{user?.name}</span>
          </span>
          <button
            type="button"
            className="topbar-icon danger"
            title="退出登录"
            aria-label="退出登录"
            onClick={() => { logout(); nav('/login') }}
          >
            <LogOut />
          </button>
        </div>
      </header>

      {/* 房态盘整页去左右留白（日历横贯主区），其余页面保持居中留白 */}
      <main className={loc.pathname === '/rooms' ? 'main main-bleed' : 'main'}>
        <Outlet />
      </main>

      <nav className="tabbar" aria-label="移动端主导航">
        {TABS.map(t => (
          <NavLink key={t.to} to={t.to} end={t.to === '/'} className={({ isActive }) => isActive ? 'active' : ''}>
            <t.icon />
            {t.label}
          </NavLink>
        ))}
        <button onClick={() => setMoreOpen(true)} className="tabbar-more">
          <Ellipsis size={22} />
          更多
        </button>
      </nav>
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} roleLine={roleLine} />
    </div>
  )
}
