import { Fragment, useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  BedDouble, BellRing, CalendarDays, ChartColumn,
  LayoutDashboard, LogOut, Monitor, Moon, ReceiptText, SlidersHorizontal, Sun, Users,
} from 'lucide-react'
import { api, type DashData, type Hotel } from './api'
import { Overlay } from './ui'
import { useAuth } from './auth'
import { useTheme, type ThemeMode } from './theme'

/** 导航项：desc 是 hover 提示（顶栏只有标题，说明不占版面） */
type NavItem = {
  to: string
  label: string
  desc: string
  icon: typeof LayoutDashboard
  /** 角标取 dashboard 的哪个字段，以及读数的量词（状态语义各家不同，不能一律「待办」） */
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

/** 移动端「账号」面板：窄屏顶栏只留头像入口，账户 / 切店 / 外观 / 退出收在这里 */
function AccountSheet({ open, onClose, roleLine, hotelSwitch }: {
  open: boolean
  onClose: () => void
  roleLine: string
  /** 平台管理员的门店切换（窄屏顶栏放不下下拉框，收进面板） */
  hotelSwitch?: React.ReactNode
}) {
  const { mode, setMode } = useTheme()
  const { user, logout } = useAuth()
  const nav = useNavigate()
  return (
    <Overlay open={open} onClose={onClose}>
      <div className="sheet-panel">
        <div className="sheet-handle" />
        <div className="sheet-account">
          <span className="avatar">{user?.name?.charAt(0)}</span>
          <div>
            <div className="sheet-account-name">{user?.name}</div>
            <div className="sheet-account-role">{roleLine}</div>
          </div>
        </div>
        {hotelSwitch && (
          <label className="sheet-hotel">
            <span className="k">门店</span>
            {hotelSwitch}
          </label>
        )}
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
        {/* 退出：窄屏没有独立入口，收在账号面板里 */}
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
  const [accountOpen, setAccountOpen] = useState(false)
  const navRef = useRef<HTMLElement>(null)
  const loc = useLocation()
  const nav = useNavigate()
  const { user, activeHotelName, activeHotelId, setActiveHotel, logout } = useAuth()

  // 平台管理员可操作的酒店全列表（与设置页共用 ['hotels'] 缓存）
  const hotels = useQuery({
    queryKey: ['hotels'],
    queryFn: () => api.get<Hotel[]>('/api/hotels'),
    enabled: user?.role === 'platform_admin',
  })
  // 导航待办计数：与仪表盘共用 ['dashboard'] 缓存。
  // 平台管理员首次登录尚未选店时没有业务上下文（后端 400），先挡掉。
  const dash = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashData>('/api/dashboard'),
    enabled: !!activeHotelId,
    staleTime: 30_000,
  })

  // 平台管理员尚未选店（首次登录）时与设置页同口径：自动选中第一家酒店作为业务上下文
  useEffect(() => {
    if (user?.role === 'platform_admin' && !activeHotelId && hotels.data?.length) {
      setActiveHotel(hotels.data[0].id, hotels.data[0].name)
    }
  }, [user, activeHotelId, hotels.data, setActiveHotel])
  // 角色 + 去掉「云栖酒店 · 」前缀的门店名（顶栏 title 与账号面板共用同一口径）。
  // 平台管理员的账号名常就叫「平台管理员」，副行必须带上当前门店，否则两行完全重复。
  const roleLine = `${user?.role_label ?? ''}${
    activeHotelName
      ? ` · ${activeHotelName.replace('云栖酒店 · ', '')}`
      : ''
  }`

  // 顶栏实测高度写进 --topbar-h：房态盘日期表头的吸附线（sticky top）靠它对齐，
  // 桌面 60px / 移动端两行高度不同，写死数值会在换布局时错位
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('.topbar')
    if (!el) return
    const apply = () => document.documentElement.style.setProperty('--topbar-h', `${el.offsetHeight}px`)
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    window.addEventListener('resize', apply)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', apply)
      document.documentElement.style.removeProperty('--topbar-h')
    }
  }, [])

  // 窄屏导航横向可滚：切页后把当前项滚到可见区中部（不做纵向滚动）
  useEffect(() => {
    const box = navRef.current
    const item = box?.querySelector<HTMLElement>('a.active')
    if (!box || !item) return
    const br = box.getBoundingClientRect()
    const ir = item.getBoundingClientRect()
    if (ir.left >= br.left + 8 && ir.right <= br.right - 8) return
    const delta = (ir.left - br.left) - (br.width - ir.width) / 2
    box.scrollTo({ left: box.scrollLeft + delta, behavior: 'smooth' })
  }, [loc.pathname])

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

  // 门店下拉的 option：顶栏（桌面）与账号面板（窄屏）共用同一份
  const hotelOptions = hotels.data?.length
    ? hotels.data.map(h => <option key={h.id} value={h.id}>{h.name}</option>)
    : [<option key="cur" value={activeHotelId ?? ''}>{activeHotelName ?? '选择酒店'}</option>]

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/" aria-label={`${activeHotelName ?? '云栖酒店'}，返回仪表盘`}>
          <span className="brand-mark" aria-hidden="true">云</span>
          <span className="brand-name">{activeHotelName ?? '云栖酒店'}</span>
          <span className="brand-pms">PMS</span>
        </a>

        <span className="topbar-div" aria-hidden="true" />

        {/* 平台管理员专属：门店切换常驻顶栏，品牌名与业务上下文同步更新 */}
        {user?.role === 'platform_admin' && (
          <label className="topbar-hotel">
            <select
              className="select"
              value={activeHotelId ?? ''}
              onChange={onSwitchHotel}
              aria-label="切换酒店"
            >
              {hotelOptions}
            </select>
          </label>
        )}

        {/* 全量导航一行铺开：不再折叠进下拉面板，跳转少一次点击 */}
        <nav className="topnav" aria-label="主导航" ref={navRef}>
          {NAV_GROUPS.map((g, gi) => (
            <Fragment key={g.group}>
              {gi > 0 && <span className="topnav-sep" aria-hidden="true" />}
              {g.items.map(it => {
                const badge = badgeOf(it)
                return (
                  <NavLink
                    key={it.to}
                    to={it.to}
                    end={it.to === '/'}
                    title={it.desc}
                    className={({ isActive }) => `tn-item${isActive ? ' active' : ''}`}
                  >
                    <it.icon />
                    <span>{it.label}</span>
                    {badge && (
                      <span
                        className={`tn-count${badge.danger ? ' red' : ''}`}
                        title={`${badge.n} ${badge.unit}`}
                      >
                        {badge.n}
                      </span>
                    )}
                  </NavLink>
                )
              })}
            </Fragment>
          ))}
        </nav>

        <div className="topbar-right">
          <span className="topbar-user" title={`${user?.name} · ${roleLine}`}>
            <span className="avatar">{user?.name?.charAt(0)}</span>
            <span className="name">{user?.name}</span>
          </span>
          <NavLink
            to="/settings"
            className={({ isActive }) => `topbar-icon${isActive ? ' active' : ''}`}
            title="系统设置"
            aria-label="系统设置"
          >
            <SlidersHorizontal />
          </NavLink>
          <ThemePicker />
          <button
            type="button"
            className="topbar-icon danger"
            title="退出登录"
            aria-label="退出登录"
            onClick={() => { logout(); nav('/login') }}
          >
            <LogOut />
          </button>
          {/* 移动端：头像 → 账号面板（外观/退出）；桌面端用上面的身份块与退出按钮 */}
          <button
            type="button"
            className="topbar-acc"
            title="账号与外观"
            aria-label="账号与外观"
            aria-haspopup="dialog"
            onClick={() => setAccountOpen(true)}
          >
            <span className="avatar">{user?.name?.charAt(0)}</span>
          </button>
        </div>
      </header>

      {/* 房态盘整页去左右留白（日历横贯主区），其余页面保持居中留白 */}
      <main className={loc.pathname === '/rooms' ? 'main main-bleed' : 'main'}>
        <Outlet />
      </main>

      <AccountSheet
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        roleLine={roleLine}
        hotelSwitch={user?.role === 'platform_admin' ? (
          <select className="select" value={activeHotelId ?? ''} onChange={onSwitchHotel} aria-label="切换酒店">
            {hotelOptions}
          </select>
        ) : null}
      />
    </div>
  )
}
