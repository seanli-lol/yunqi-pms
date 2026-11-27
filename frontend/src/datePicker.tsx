import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react'
import { todayIso } from './api'

export type DateSide = 'start' | 'end'

/* ---------- 本地日期计算工具（避免 UTC 时区偏移） ---------- */
function parseIso(iso: string): { y: number; m: number; d: number } | null {
  const parts = iso.split('-').map(Number)
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null
  return { y: parts[0], m: parts[1], d: parts[2] }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export function formatIso(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`
}

export function displayIso(iso: string): string {
  return iso ? iso.replace(/-/g, '/') : ''
}

export function shiftIso(iso: string, days: number): string {
  const p = parseIso(iso)
  if (!p) return iso
  const dt = new Date(p.y, p.m - 1, p.d + days)
  return formatIso(dt.getFullYear(), dt.getMonth() + 1, dt.getDate())
}

export function diffDaysIso(fromIso: string, toIso: string): number {
  const a = parseIso(fromIso)
  const b = parseIso(toIso)
  if (!a || !b) return 0
  const ta = new Date(a.y, a.m - 1, a.d).getTime()
  const tb = new Date(b.y, b.m - 1, b.d).getTime()
  return Math.round((tb - ta) / 86400000)
}

interface DayCell {
  iso: string
  day: number
  inMonth: boolean
}

function buildMonthGrid(y: number, m: number): DayCell[] {
  const firstDow = new Date(y, m - 1, 1).getDay() // 0 = 周日
  const cells: DayCell[] = []
  for (let i = 0; i < 42; i++) {
    const dt = new Date(y, m - 1, 1 - firstDow + i)
    const cy = dt.getFullYear()
    const cm = dt.getMonth() + 1
    const cd = dt.getDate()
    cells.push({
      iso: formatIso(cy, cm, cd),
      day: cd,
      inMonth: cy === y && cm === m,
    })
  }
  return cells
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

/* ---------- 状态管理 Hook ---------- */
export interface DateRangePickerOptions {
  start: string
  end: string
  /** keepEnd=true 表示用户先选了结束日期、再自动切过来选开始日期，此时应保持结束日期不动 */
  onStartChange: (iso: string, keepEnd?: boolean) => void
  onEndChange: (iso: string) => void
  /** 一轮双向选择完成（选中第二个日期）时触发 */
  onComplete?: (start: string, end: string) => void
  /** 是否允许 start === end（报表为 true，预订为 false） */
  allowSameDay?: boolean
  /** 结束日期是否禁用（如钟点房） */
  endDisabled?: boolean
  startLabel?: string
  endLabel?: string
}

export interface DateRangeController {
  active: DateSide | null
  startedBy: DateSide | null
  start: string
  end: string
  allowSameDay: boolean
  endDisabled: boolean
  startLabel: string
  endLabel: string
  startRef: React.RefObject<HTMLButtonElement>
  endRef: React.RefObject<HTMLButtonElement>
  openStart: () => void
  openEnd: () => void
  close: () => void
  pick: (iso: string) => void
}

export function useDateRangePicker(opts: DateRangePickerOptions): DateRangeController {
  const {
    start,
    end,
    onStartChange,
    onEndChange,
    onComplete,
    allowSameDay = true,
    endDisabled = false,
    startLabel = '开始日期',
    endLabel = '结束日期',
  } = opts

  const [active, setActive] = useState<DateSide | null>(null)
  const [startedBy, setStartedBy] = useState<DateSide | null>(null)
  const startRef = useRef<HTMLButtonElement>(null)
  const endRef = useRef<HTMLButtonElement>(null)

  // 结束日期被动态禁用时，若当前正停在 end 态则收起
  useEffect(() => {
    if (endDisabled && active === 'end') {
      setActive(null)
      setStartedBy(null)
    }
  }, [endDisabled, active])

  const close = useCallback(() => {
    setActive(null)
    setStartedBy(null)
  }, [])

  const openStart = useCallback(() => {
    setActive(prev => {
      if (prev === 'start') {
        setStartedBy(null)
        return null
      }
      setStartedBy('start')
      return 'start'
    })
  }, [])

  const openEnd = useCallback(() => {
    if (endDisabled) return
    setActive(prev => {
      if (prev === 'end') {
        setStartedBy(null)
        return null
      }
      setStartedBy('end')
      return 'end'
    })
  }, [endDisabled])

  const pick = useCallback((iso: string) => {
    if (active === 'start') {
      if (startedBy === 'end') {
        // 先选了结束日，现在选开始日 → 保持结束日不动，选完收起并触发 onComplete
        onStartChange(iso, true)
        setActive(null)
        setStartedBy(null)
        onComplete?.(iso, end)
      } else {
        // 先选开始日
        onStartChange(iso, false)
        if (allowSameDay && end && iso > end) {
          onEndChange(iso)
        }
        if (endDisabled) {
          setActive(null)
          setStartedBy(null)
        } else {
          // 自动打开结束日期选择
          setActive('end')
        }
      }
    } else if (active === 'end') {
      if (startedBy === 'start') {
        // 先选了开始日，现在选结束日 → 选完收起并触发 onComplete
        onEndChange(iso)
        setActive(null)
        setStartedBy(null)
        onComplete?.(start, iso)
      } else {
        // 先选结束日：若允许同日且早于开始日，把开始日对齐到结束日
        if (allowSameDay && start && iso < start) {
          onStartChange(iso, false)
        }
        onEndChange(iso)
        // 自动打开开始日期选择
        setActive('start')
      }
    }
  }, [active, startedBy, start, end, allowSameDay, endDisabled, onStartChange, onEndChange, onComplete])

  return {
    active,
    startedBy,
    start,
    end,
    allowSameDay,
    endDisabled,
    startLabel,
    endLabel,
    startRef,
    endRef,
    openStart,
    openEnd,
    close,
    pick,
  }
}

/* ---------- 触发输入框按钮（复用 .input 视觉语言） ---------- */
export function DateRangeInput({
  ctrl,
  side,
  placeholder = '选择日期',
  id,
}: {
  ctrl: DateRangeController
  side: DateSide
  placeholder?: string
  id?: string
}) {
  const isStart = side === 'start'
  const value = isStart ? ctrl.start : ctrl.end
  const disabled = !isStart && ctrl.endDisabled
  const isActive = ctrl.active === side
  const ref = isStart ? ctrl.startRef : ctrl.endRef
  const onClick = isStart ? ctrl.openStart : ctrl.openEnd

  return (
    <button
      ref={ref}
      id={id}
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`input date-trigger${isActive ? ' active' : ''}`}
      aria-haspopup="dialog"
      aria-expanded={isActive}
    >
      <span className={`date-trigger-val${value ? '' : ' placeholder'}`}>
        {value ? displayIso(value) : placeholder}
      </span>
      <Calendar size={16} className="date-trigger-ico" aria-hidden="true" />
    </button>
  )
}

/* ---------- 日历浮层（Portal 到 body，避免被 Dialog overflow 裁剪） ---------- */
export function DateRangePopover({ ctrl }: { ctrl: DateRangeController }) {
  const { active, startedBy, start, end, allowSameDay, endDisabled, startLabel, endLabel, startRef, endRef, close, pick } = ctrl
  const popRef = useRef<HTMLDivElement>(null)
  const [hoverIso, setHoverIso] = useState<string | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number; ready: boolean }>({ top: 0, left: 0, ready: false })

  const today = todayIso()

  // 当前展示的年月
  const initialDate = parseIso((active === 'end' ? end : start) || today) ?? { y: 2026, m: 1, d: 1 }
  const [view, setView] = useState<{ y: number; m: number }>({ y: initialDate.y, m: initialDate.m })

  // 打开或切换 active 时，同步日历展示月份（若是刚从 start 切到 end，且 start 已更新，留在 start 所在月或 end 所在月）
  useEffect(() => {
    if (!active) {
      setHoverIso(null)
      return
    }
    const anchorIso =
      active === 'end'
        ? (startedBy === 'start' ? (start || end || today) : (end || today))
        : (startedBy === 'end' ? (end || start || today) : (start || today))
    const p = parseIso(anchorIso)
    if (p) setView({ y: p.y, m: p.m })
  }, [active, startedBy]) // 仅在打开或切换端时自动对齐月份，不干扰用户手动翻月

  // 定位计算：跟随当前激活触发器，并避让视口边缘
  const updatePosition = useCallback(() => {
    if (!active) return
    const trigger = active === 'start' ? startRef.current : endRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const popW = popRef.current?.offsetWidth || 300
    const popH = popRef.current?.offsetHeight || 356
    const gap = 8
    const pad = 12

    let top = rect.bottom + gap
    if (top + popH > window.innerHeight - pad) {
      const above = rect.top - popH - gap
      top = above >= pad ? above : Math.max(pad, window.innerHeight - popH - pad)
    }

    let left = rect.left
    if (left + popW > window.innerWidth - pad) {
      left = Math.max(pad, window.innerWidth - popW - pad)
    }
    setPos({ top, left, ready: true })
  }, [active, startRef, endRef])

  useLayoutEffect(() => {
    if (!active) {
      setPos(p => (p.ready ? { ...p, ready: false } : p))
      return
    }
    updatePosition()
    const onScroll = () => updatePosition()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [active, updatePosition])

  // 外部点击与 Esc 关闭（capture 阶段拦截 Esc，避免同时关闭外层 Dialog）
  useEffect(() => {
    if (!active) return
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t)) return
      if (startRef.current?.contains(t) || endRef.current?.contains(t)) return
      close()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [active, close, startRef, endRef])

  const cells = useMemo(() => buildMonthGrid(view.y, view.m), [view.y, view.m])

  if (!active) return null

  const shiftMonth = (delta: number) => {
    setView(v => {
      const dt = new Date(v.y, v.m - 1 + delta, 1)
      return { y: dt.getFullYear(), m: dt.getMonth() + 1 }
    })
  }

  // 是否禁用某一天（仅在“选第二个日期”阶段限制非法方向，避免倒挂）
  const isDisabled = (iso: string): boolean => {
    if (active === 'end' && startedBy === 'start' && start) {
      return allowSameDay ? iso < start : iso <= start
    }
    if (active === 'start' && startedBy === 'end' && end) {
      return allowSameDay ? iso > end : iso >= end
    }
    return false
  }

  // 计算预览区间（悬停时给用户直观的起止高亮反馈）
  let rangeStart = start
  let rangeEnd = end
  if (hoverIso && !isDisabled(hoverIso)) {
    if (active === 'end' && startedBy === 'start' && start) {
      rangeStart = start
      rangeEnd = hoverIso
    } else if (active === 'start' && startedBy === 'end' && end) {
      rangeStart = hoverIso
      rangeEnd = end
    }
  }
  const hasRange = Boolean(rangeStart && rangeEnd && rangeStart <= rangeEnd)

  const stepText = endDisabled
    ? `选择${startLabel}`
    : active === 'start'
      ? (startedBy === 'end' ? `选择${startLabel}` : `选择${startLabel}，选完自动选${endLabel}`)
      : (startedBy === 'start' ? `选择${endLabel}` : `选择${endLabel}，选完自动选${startLabel}`)

  const jumpToday = () => {
    const p = parseIso(today)
    if (p) setView({ y: p.y, m: p.m })
    if (!isDisabled(today)) pick(today)
  }

  return createPortal(
    <div
      ref={popRef}
      className="date-pop"
      role="dialog"
      aria-label={active === 'start' ? startLabel : endLabel}
      style={{
        top: pos.top,
        left: pos.left,
        visibility: pos.ready ? 'visible' : 'hidden',
      }}
    >
      <div className="date-pop-step">
        <span className="date-pop-dot" />
        <span>{stepText}</span>
      </div>

      <div className="date-pop-head">
        <button type="button" className="icon-btn date-nav" aria-label="上个月" onClick={() => shiftMonth(-1)}>
          <ChevronLeft size={16} />
        </button>
        <div className="date-pop-ym">{view.y} 年 {view.m} 月</div>
        <button type="button" className="icon-btn date-nav" aria-label="下个月" onClick={() => shiftMonth(1)}>
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="date-weekdays">
        {WEEKDAYS.map(w => <span key={w}>{w}</span>)}
      </div>

      <div className="date-grid" onMouseLeave={() => setHoverIso(null)}>
        {cells.map(c => {
          const disabled = isDisabled(c.iso)
          const isStart = Boolean(rangeStart && c.iso === rangeStart)
          const isEnd = Boolean(rangeEnd && c.iso === rangeEnd)
          const inRange = hasRange && c.iso > rangeStart && c.iso < rangeEnd
          const isToday = c.iso === today

          const cls = [
            'date-cell',
            !c.inMonth && 'is-muted',
            disabled && 'is-disabled',
            isStart && 'is-start',
            isEnd && 'is-end',
            inRange && 'is-in-range',
            isToday && 'is-today',
          ].filter(Boolean).join(' ')

          return (
            <button
              key={c.iso}
              type="button"
              disabled={disabled}
              className={cls}
              onMouseEnter={() => setHoverIso(c.iso)}
              onClick={() => { if (!disabled) pick(c.iso) }}
            >
              <span>{c.day}</span>
            </button>
          )
        })}
      </div>

      <div className="date-pop-foot">
        <button type="button" className="btn-link" onClick={jumpToday} disabled={isDisabled(today)}>
          今天
        </button>
        <button type="button" className="btn-link muted" onClick={close}>
          关闭
        </button>
      </div>
    </div>,
    document.body
  )
}
