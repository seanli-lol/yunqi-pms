import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  BedDouble, BellRing, CalendarDays, ChevronRight, ChevronsLeft, Ellipsis, LayoutDashboard,
  ReceiptText, SlidersHorizontal, Users, ChartColumn,
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
  // 侧栏收起（图标栏 + 悬停气泡），与原型 app.js 同款，localStorage 记忆
  const [rail, setRail] = useState(() => {
    try { return localStorage.getItem('pms_rail') === '1' } catch { return false }
  })
  const loc = useLocation()
  const nav = useNavigate()
  const { user, activeHotelName, activeHotelId, setActiveHotel, logout } = useAuth()

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
                <NavLink key={it.to} to={it.to} end={it.to === '/'} className={({ isActive }) => isActive ? 'active' : ''}
                  data-tip={it.label}>
                  <it.icon />
                  {it.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-user">
          <span className="avatar" data-tip={user?.name}>{user?.name?.charAt(0)}</span>
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
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} />
    </div>
  )
}
