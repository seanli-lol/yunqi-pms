import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'

/* ---------- Toast ---------- */
const ToastCtx = createContext<(msg: string) => void>(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null)
  const timer = useRef<number>(0)
  const toast = useCallback((m: string) => {
    setMsg(m)
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setMsg(null), 2400)
  }, [])
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className={`toast${msg ? ' show' : ''}`} role="status">{msg}</div>
    </ToastCtx.Provider>
  )
}

/* ---------- Overlay（对话框 / 抽屉） ---------- */
/* 滚动锁引用计数：叠层弹层（抽屉 + 对话框）关闭内层时不会误解锁背景 */
let overlayOpenCount = 0
function lockBodyScroll() {
  overlayOpenCount += 1
  document.body.style.overflow = 'hidden'
}
function unlockBodyScroll() {
  overlayOpenCount = Math.max(0, overlayOpenCount - 1)
  if (overlayOpenCount === 0) document.body.style.overflow = ''
}

export function Overlay({ open, onClose, children, drawer = false }: {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  drawer?: boolean
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    lockBodyScroll()
    return () => {
      document.removeEventListener('keydown', onKey)
      unlockBodyScroll()
    }
  }, [open, onClose])
  if (!open) return null
  return (
    <div
      className={drawer ? 'overlay drawer-wrap open' : 'overlay'}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      {children}
    </div>
  )
}

export function Dialog({ open, onClose, title, sub, children, foot, wide = false }: {
  open: boolean
  onClose: () => void
  title: React.ReactNode
  sub?: React.ReactNode
  children: React.ReactNode
  foot?: React.ReactNode
  wide?: boolean
}) {
  return (
    <Overlay open={open} onClose={onClose}>
      <div className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true">
        <div className="dialog-head">
          <div>
            <div className="dialog-title">{title}</div>
            {sub && <div className="dialog-sub">{sub}</div>}
          </div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="dialog-body">{children}</div>
        {foot && <div className="dialog-foot">{foot}</div>}
      </div>
    </Overlay>
  )
}

export function Drawer({ open, onClose, title, sub, children, foot }: {
  open: boolean
  onClose: () => void
  title: React.ReactNode
  sub?: React.ReactNode
  children: React.ReactNode
  foot?: React.ReactNode
}) {
  return (
    <Overlay open={open} onClose={onClose} drawer>
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="dialog-head" style={{ paddingBottom: 16, borderBottom: '1px solid var(--hairline-soft)' }}>
          <div>
            <div className="dialog-title">{title}</div>
            {sub && <div className="dialog-sub">{sub}</div>}
          </div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="card-body" style={{ flex: 1, overflowY: 'auto' }}>{children}</div>
        {foot && <div className="dialog-foot" style={{ borderTop: '1px solid var(--hairline-soft)' }}>{foot}</div>}
      </aside>
    </Overlay>
  )
}

/* ---------- 基础元素 ---------- */
export function PageHead({ title, desc, actions }: { title: string; desc?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {desc && <p className="page-desc">{desc}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  )
}

export function Stat({ label, value, unit, sub }: { label: string; value: React.ReactNode; unit?: string; sub?: React.ReactNode }) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}{unit && <span className="unit">{unit}</span>}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

const BADGE_COLORS: Record<string, string> = {
  green: 'badge-green', orange: 'badge-orange', red: 'badge-red',
  blue: 'badge-blue', gray: 'badge-gray', purple: 'badge-purple',
}

export function Badge({ color = 'gray', children }: { color?: keyof typeof BADGE_COLORS; children: React.ReactNode }) {
  return <span className={`badge ${BADGE_COLORS[color]}`}>{children}</span>
}

export const RES_STATUS_BADGE: Record<string, { color: keyof typeof BADGE_COLORS; label: string }> = {
  pending: { color: 'orange', label: '待确认' },
  confirmed: { color: 'green', label: '已确认' },
  checked_in: { color: 'blue', label: '已入住' },
  checked_out: { color: 'gray', label: '已离店' },
  cancelled: { color: 'gray', label: '已取消' },
  no_show: { color: 'gray', label: '未到店' },
}

export function Segmented<T extends string>({ value, options, onChange }: {
  value: T
  options: { key: T; label: React.ReactNode }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map(o => (
        <button key={o.key} className={value === o.key ? 'active' : ''} onClick={() => onChange(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Field({ label, required, hint, children }: {
  label: string; required?: boolean; hint?: string; children: React.ReactNode
}) {
  return (
    <div className="field">
      <label className="label">{label}{required && <span className="req">*</span>}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  )
}

export function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>
}

export function Spinner() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', padding: '48px 0', color: 'var(--text-tertiary)' }}>
      加载中…
    </div>
  )
}
