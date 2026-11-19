import { useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  BedDouble, BellRing, CalendarDays, ChevronRight, Ellipsis, LayoutDashboard,
  ReceiptText, SlidersHorizontal, Sparkles, Users, ChartColumn,
} from 'lucide-react'
import { Overlay } from './ui'
import { useAuth } from './auth'

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
    { to: '/housekeeping', label: '客房清洁', icon: Sparkles, tab: 'hk' },
    { to: '/reports', label: '经营报表', icon: ChartColumn, tab: 'more' },
  ]},
  { group: '系统', items: [
    { to: '/settings', label: '设置', icon: SlidersHorizontal, tab: 'more' },
  ]},
]

const TABS = [
  { to: '/', label: '仪表盘', icon: LayoutDashboard, tab: 'dash' },
  { to: '/rooms', label: '房态盘', icon: BedDouble, tab: 'rooms' },
  { to: '/front-desk', label: '前台', icon: BellRing, tab: 'desk' },
  { to: '/housekeeping', label: '清洁', icon: Sparkles, tab: 'hk' },
]

function MoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
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
        {extras.map(x => (
          <NavLink key={x.to} to={x.to} className="sheet-link" onClick={onClose}>
            <x.icon />
            {x.label}
            <ChevronRight className="chev" />
          </NavLink>
        ))}
      </div>
    </Overlay>
  )
}

export default function AppShell() {
  const [moreOpen, setMoreOpen] = useState(false)
  const loc = useLocation()
  const nav = useNavigate()
  const { user, activeHotelName, activeHotelId, setActiveHotel, logout } = useAuth()

  // 平台管理员切换酒店
  const onSwitchHotel = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = Number(e.target.value)
    const name = e.target.selectedOptions[0]?.textContent ?? ''
    setActiveHotel(id, name)
    nav(loc.pathname)
    window.location.reload()
  }

  return (
    <div className="app">
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
            <div style={{ padding: '8px 10px' }}>
              <select
                className="select" style={{ height: 36, fontSize: 13 }}
                value={activeHotelId ?? ''} onChange={onSwitchHotel}
                aria-label="切换酒店"
              >
                <option value={activeHotelId ?? ''}>{activeHotelName ?? '选择酒店'}</option>
              </select>
            </div>
          )}
          {NAV.map(g => (
            <div key={g.group}>
              <span className="nav-label">{g.group}</span>
              {g.items.map(it => (
                <NavLink key={it.to} to={it.to} end={it.to === '/'} className={({ isActive }) => isActive ? 'active' : ''}>
                  <it.icon />
                  {it.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-user">
          <span className="avatar">{user?.name?.charAt(0)}</span>
          <div className="user-name">
            {user?.name}
            <br />
            <span className="user-role">{user?.role_label}{activeHotelName && user?.role !== 'platform_admin' ? ` · ${activeHotelName.replace('云栖酒店 · ', '')}` : ''}</span>
          </div>
          <button
            className="btn btn-quiet btn-sm" style={{ marginLeft: 'auto' }}
            onClick={() => { logout(); nav('/login') }}
          >
            退出
          </button>
        </div>
      </aside>

      <main className="main">
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
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} />
    </div>
  )
}
