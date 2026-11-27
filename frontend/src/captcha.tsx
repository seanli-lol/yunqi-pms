import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, Loader2, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { api } from './api'

/** 服务端下发的 PNG 拼图题目（坐标均为逻辑像素，前端按渲染宽度比例换算） */
interface CaptchaQuestion {
  id: string
  bg: string
  piece: string
  y: number
  width: number
  height: number
  size: number
  escalated: boolean
}

type TrailPoint = [number, number, number]

interface Props {
  open: boolean
  onClose: () => void
  /** 验证通过后回调一次性票据（调用方自动提交登录） */
  onVerified: (token: string) => void
}

const HANDLE = 42   // 滑块手柄宽度
const INSET = 2     // 滑块左右内缩

/**
 * 安全验证浮层（点击「登录」触发）：
 * - 服务端渲染 2× HiDPI PNG 异形凹凸拼图 + 1~2 个干扰假缺口；
 * - 前端按比例映射拖动并实时采集人机轨迹 [dt_ms, logical_x, dy_px]；
 * - 校验通过后短暂停留绿标反馈，自动回调提交登录。
 */
export function CaptchaModal({ open, onClose, onVerified }: Props) {
  const [q, setQ] = useState<CaptchaQuestion | null>(null)
  const [loading, setLoading] = useState(false)
  const [offset, setOffset] = useState(0)
  const [bounds, setBounds] = useState({ handleMax: 1, pieceMax: 1, stageW: 320 })
  const [draggingUI, setDraggingUI] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [checking, setChecking] = useState(false)
  const [verified, setVerified] = useState(false)
  const [failed, setFailed] = useState(false)
  const [banner, setBanner] = useState<{ type: 'ok' | 'fail'; text: string } | null>(null)

  const stageRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const offsetRef = useRef(0)
  const boundsRef = useRef(bounds)
  boundsRef.current = bounds

  const dragRef = useRef<{
    startX: number
    startY: number
    base: number
    t0: number
    lastT: number
    lastX: number
    trail: TrailPoint[]
  } | null>(null)
  const timerRef = useRef<number>(0)
  const reqIdRef = useRef(0)

  const clearTimers = () => {
    window.clearTimeout(timerRef.current)
  }

  const load = useCallback(async () => {
    const rid = ++reqIdRef.current
    clearTimers()
    dragRef.current = null
    offsetRef.current = 0
    setOffset(0)
    setDraggingUI(false)
    setResetting(false)
    setChecking(false)
    setVerified(false)
    setFailed(false)
    setBanner(null)
    setLoading(true)
    try {
      const r = await api.get('/api/auth/captcha', { skipHotel: true })
      if (rid !== reqIdRef.current) return
      if (!r?.enabled) {
        onVerified('')
        return
      }
      setQ({
        id: r.id,
        bg: r.bg,
        piece: r.piece,
        y: r.y,
        width: r.width,
        height: r.height,
        size: r.size,
        escalated: Boolean(r.escalated),
      })
    } catch (e: any) {
      if (rid !== reqIdRef.current) return
      setQ(null)
      setFailed(true)
      setBanner({ type: 'fail', text: e?.message || '验证码加载失败，请点击刷新' })
    } finally {
      if (rid === reqIdRef.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 打开浮层时加载新题；关闭时清理定时器与状态
  useEffect(() => {
    if (open) {
      load()
    } else {
      reqIdRef.current += 1
      clearTimers()
      dragRef.current = null
      setDraggingUI(false)
    }
    return clearTimers
  }, [open, load])

  // Esc 关闭浮层（校验中 / 已通过时锁定避免误关）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !checking && !verified) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, checking, verified, onClose])

  // 实测画布与滑轨尺寸：比例映射满行程，兼容任意屏宽
  useEffect(() => {
    if (!open || !stageRef.current || !trackRef.current) return
    const calc = () => {
      const stageW = stageRef.current?.clientWidth || 320
      const trackW = trackRef.current?.clientWidth || stageW
      const logicalW = q?.width || 320
      const logicalSize = q?.size || 58
      const pieceRendered = (logicalSize / logicalW) * stageW
      const next = {
        handleMax: Math.max(1, trackW - HANDLE - INSET * 2),
        pieceMax: Math.max(1, stageW - pieceRendered),
        stageW,
      }
      boundsRef.current = next
      setBounds(next)
    }
    calc()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(calc) : null
    ro?.observe(stageRef.current)
    window.addEventListener('resize', calc)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', calc)
    }
  }, [open, q])

  if (!open) return null

  const toLogicalX = (handleOffset: number, question: CaptchaQuestion) => {
    const b = boundsRef.current
    const pieceLeft = (handleOffset / b.handleMax) * b.pieceMax
    return Math.round((pieceLeft / b.stageW) * question.width)
  }

  const pieceLeft = (offset / bounds.handleMax) * bounds.pieceMax

  const triggerFail = (msg: string, autoReload: boolean) => {
    setFailed(true)
    setResetting(true)
    setBanner({ type: 'fail', text: msg })
    offsetRef.current = 0
    setOffset(0)
    if (autoReload) {
      clearTimers()
      timerRef.current = window.setTimeout(() => load(), 720)
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (verified || checking || loading || !q) return
    e.preventDefault()
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    } catch { /* ignore */ }
    const startLogical = toLogicalX(offsetRef.current, q)
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      base: offsetRef.current,
      t0: performance.now(),
      lastT: 0,
      lastX: startLogical,
      trail: [[0, startLogical, 0]],
    }
    setDraggingUI(true)
    setResetting(false)
    setFailed(false)
    setBanner(null)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const st = dragRef.current
    if (!st || !q) return
    const next = Math.min(boundsRef.current.handleMax, Math.max(0, st.base + e.clientX - st.startX))
    offsetRef.current = next
    setOffset(next)

    const dt = Math.max(st.lastT, Math.round(performance.now() - st.t0))
    const lx = toLogicalX(next, q)
    const dy = Math.round(e.clientY - st.startY)
    if (st.trail.length < 118 && (dt - st.lastT >= 12 || Math.abs(lx - st.lastX) >= 2)) {
      st.trail.push([dt, lx, dy])
      st.lastT = dt
      st.lastX = lx
    }
  }

  const onPointerUp = async (e: React.PointerEvent) => {
    const st = dragRef.current
    if (!st || !q) return
    dragRef.current = null
    setDraggingUI(false)

    const finalOffset = offsetRef.current
    const logicalX = toLogicalX(finalOffset, q)
    const durationMs = Math.max(st.lastT + 1, Math.round(performance.now() - st.t0))
    const dy = Math.round(e.clientY - st.startY)
    const last = st.trail[st.trail.length - 1]
    if (!last || last[0] !== durationMs || last[1] !== logicalX) {
      st.trail.push([durationMs, logicalX, dy])
    }

    setChecking(true)
    try {
      const r = await api.post(
        '/api/auth/captcha/verify',
        { id: q.id, x: logicalX, duration_ms: durationMs, trail: st.trail },
        { skipHotel: true },
      )
      if (r?.ok && r.captcha_token) {
        setVerified(true)
        setFailed(false)
        setBanner({ type: 'ok', text: `验证通过 · ${(durationMs / 1000).toFixed(1)}s` })
        clearTimers()
        timerRef.current = window.setTimeout(() => {
          onVerified(r.captcha_token)
        }, 460)
      } else {
        triggerFail('验证未通过，请重新对齐', true)
      }
    } catch (err: any) {
      const isThrottle = err?.status === 429
      triggerFail(isThrottle ? (err.message || '验证过于频繁，请稍后再试') : '验证未通过，请重新对齐', !isThrottle)
    } finally {
      setChecking(false)
    }
  }

  const onPointerCancel = () => {
    dragRef.current = null
    setDraggingUI(false)
  }

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !checking && !verified) onClose()
      }}
    >
      <div
        className={`dialog captcha-modal${failed ? ' captcha-fail' : ''}${verified ? ' captcha-ok' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="captcha-modal-title"
      >
        <div className="captcha-head">
          <div className="captcha-head-left">
            <span className="captcha-shield" aria-hidden="true">
              <ShieldCheck />
            </span>
            <div>
              <div className="captcha-title-row">
                <h2 className="captcha-title" id="captcha-modal-title">安全验证</h2>
                {q?.escalated && <span className="badge badge-orange">强化验证</span>}
              </div>
              <p className="captcha-sub">拖动滑块对齐正确缺口</p>
            </div>
          </div>
          <div className="captcha-actions">
            <button
              type="button"
              className={`icon-btn${loading ? ' spinning' : ''}`}
              title="换一张"
              aria-label="换一张"
              disabled={loading || checking || verified}
              onClick={() => load()}
            >
              <RefreshCw />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="关闭"
              aria-label="关闭"
              disabled={checking || verified}
              onClick={onClose}
            >
              <X />
            </button>
          </div>
        </div>

        <div className="captcha-body">
          <div
            ref={stageRef}
            className={`captcha-stage${draggingUI ? ' is-dragging' : ''}${resetting ? ' is-resetting' : ''}`}
            style={{ aspectRatio: q ? `${q.width} / ${q.height}` : '2 / 1' }}
          >
            {loading && !q && <div className="captcha-skeleton">正在生成拼图…</div>}
            {q && (
              <>
                <img src={q.bg} alt="拖动下方滑块对齐拼图缺口" draggable={false} />
                <img
                  className="captcha-piece"
                  src={q.piece}
                  alt=""
                  draggable={false}
                  style={{
                    width: `${(q.size / q.width) * 100}%`,
                    top: `${(q.y / q.height) * 100}%`,
                    left: `${pieceLeft}px`,
                  }}
                />
              </>
            )}
            {banner && (
              <div className={`captcha-banner ${banner.type}`} role="status">
                {banner.type === 'ok' ? <Check /> : <X />}
                <span>{banner.text}</span>
              </div>
            )}
          </div>

          <div
            ref={trackRef}
            className={`captcha-track${draggingUI ? ' is-dragging' : ''}${resetting ? ' is-resetting' : ''}`}
          >
            <div
              className="captcha-fill"
              style={{ width: offset > 0 ? offset + HANDLE + INSET * 2 : 0 }}
            />
            <span className="captcha-tip">
              {verified ? '验证通过' : checking ? '校验中…' : failed ? '验证未通过，请重试' : '向右拖动滑块完成拼图'}
            </span>
            <button
              type="button"
              className="captcha-handle"
              style={{ transform: `translateX(${offset}px)` }}
              aria-label="向右拖动滑块完成拼图"
              disabled={verified || checking || loading || !q}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
            >
              {verified ? <Check /> : checking ? <Loader2 className="captcha-spin-icon" /> : failed ? <X /> : <ArrowRight />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
