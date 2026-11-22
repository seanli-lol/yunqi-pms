import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  BedDouble, BellRing, CalendarDays, ChevronRight, ChevronsLeft, Ellipsis, LayoutDashboard,
  LogOut, Monitor, Moon, ReceiptText, SlidersHorizontal, Sun, Users, ChartColumn,
} from 'lucide-react'
import { api, type Hotel } from './api'
import { Overlay } from './ui'
import { useAuth } from './auth'
import { useTheme, type ThemeMode } from './theme'

const NAV = [
  { group: '运营', items: [
    { to: '/', label: '仪表盘', icon: LayoutDashboard, tab: 'dash' },
    { to: '/rooms', label: '房态盘', icon: BedDouble, tab: 'rooms' },
    { to: '/front-desk', label: '前台', icon: BellRing, tab: 'desk' },
    { to: '/reservations', label: '预订', icon: CalendarDays, tab: 'more' },
  ]},
  { group: '经营', items: [
    { to: '/billing', label: '账务', icon: ReceiptText, tab: 'more' },
    { to: '/guests', label: '客户', icon: Users, tab: 'more' },
    { to: '/reports', label: '经营报表', icon: ChartColumn, tab: 'more' },
  ]},
  // 设置不在这里：桌面端已移到顶栏右上角（图标），移动端在「更多」面板
]

const TABS = [
  { to: '/', label: '仪表盘', icon: LayoutDashboard, tab: 'dash' },
  { to: '/rooms', label: '房态盘', icon: BedDouble, tab: 'rooms' },
  { to: '/front-desk', label: '前台', icon: BellRing, tab: 'desk' },
]

/* ---- 主题：三态定义与图标（与 prototype/theme.js 的 LABEL/ICON 一致） ---- */
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

  // 点外部 / Esc 关闭
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
  // 侧栏收起（图标栏 + 悬停气泡），与原型 app.js 同款，localStorage 记忆
  const [rail, setRail] = useState(() => {
    try { return localStorage.getItem('pms_rail') === '1' } catch { return false }
  })
  const loc = useLocation()
  const nav = useNavigate()
  const { user, activeHotelName, activeHotelId, setActiveHotel, logout } = useAuth()
  // 平台管理员可操作的酒店全列表（与设置页共用 ['hotels'] 缓存）
  const hotels = useQuery({
    queryKey: ['hotels'],
    queryFn: () => api.get<Hotel[]>('/api/hotels'),
    enabled: user?.role === 'platform_admin',
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

  useEffect(() => {
    try { localStorage.setItem('pms_rail', rail ? '1' : '0') } catch { /* 忽略 */ }
  }, [rail])

  const toggleRail = () => setRail(r => !r)

  // 平台管理员切换酒店
  const onSwitchHotel = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = Number(e.target.value)
    const name = e.target.selectedOptions[0]?.textContent ?? ''
    setActiveHotel(id, name)
    nav(loc.pathname)
    window.location.reload()
  }

  return (
    <div className={rail ? 'app rail' : 'app'}>
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="brand-mark">云</span>
          <span className="brand-text">
            <span className="brand-name">{activeHotelName ?? '云栖酒店'}</span>
            <span className="brand-sub">PMS 管理系统</span>
          </span>
        </a>
        <nav className="nav">
          {user?.role === 'platform_admin' && (
            <div className="hotel-switch" style={{ padding: '8px 10px' }}>
              <select
                className="select" style={{ height: 36, fontSize: 13 }}
                value={activeHotelId ?? ''} onChange={onSwitchHotel}
                aria-label="切换酒店"
              >
                {hotels.data?.length
                  ? hotels.data.map(h => <option key={h.id} value={h.id}>{h.name}</option>)
                  : <option value={activeHotelId ?? ''}>{activeHotelName ?? '选择酒店'}</option>}
              </select>
            </div>
          )}
          {NAV.map(g => (
            <div key={g.group}>
              <span className="nav-label">{g.group}</span>
              {g.items.map(it => (
                <NavLink key={it.to} to={it.to} end={it.to === '/'} className={({ isActive }) => isActive ? 'active' : ''}
                  data-tip={it.label}>
                  <it.icon />
                  {it.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <button
          type="button"
          className="sidebar-collapse"
          data-tip={rail ? '展开侧栏' : '收起侧栏'}
          aria-label={rail ? '展开侧栏' : '收起侧栏'}
          aria-expanded={!rail}
          onClick={toggleRail}
        >
          <ChevronsLeft size={17} strokeWidth={1.8} />
          <span>收起侧栏</span>
        </button>
      </aside>

      {/* 内容列：顶栏 + main。作为 .app 两列 grid 的第二个 item，
          不引入 grid-template-rows，避免 main 被 auto-placement 挤进侧栏列 */}
      <div className="app-content">
        <header className="topbar">
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
        </header>

        {/* 房态盘整页去左右留白（日历横贯主区），其余页面保持居中留白 */}
        <main className={loc.pathname === '/rooms' ? 'main main-bleed' : 'main'}>
          <Outlet />
        </main>
      </div>

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
