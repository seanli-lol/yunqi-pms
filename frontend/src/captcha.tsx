import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'

/** 服务端下发的验证码题目（坐标均为逻辑像素，前端按渲染宽度换算） */
interface CaptchaQuestion {
  id: string
  bg: string
  piece: string
  y: number
  width: number
  height: number
  size: number
}

interface Props {
  /** 验证通过回调（传一次性票据）；重置/失败回调 null */
  onVerified: (token: string | null) => void
  /** 变化时重新出题（登录失败后由父组件 +1） */
  resetKey?: number
  /** 后端是否启用验证码（关闭时父组件不用等滑块） */
  onEnabled?: (enabled: boolean) => void
}

const HANDLE = 40   // 滑块边长
const INSET = 2     // 滑块内缩
const GAP = 6       // 允许的偏移误差（与后端 captcha.TOLERANCE 一致）

/**
 * 拼图缺口滑块：服务端出图，前端只能看到缺口高亮位置，拖动对齐后由服务端判定。
 * 通过后拿到一次性票据，随登录请求提交。
 */
export function SliderCaptcha({ onVerified, resetKey = 0, onEnabled }: Props) {
  const [q, setQ] = useState<CaptchaQuestion | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [offset, setOffset] = useState(0)          // 滑块位移（渲染像素）
  const [bounds, setBounds] = useState({ handleMax: 0, pieceMax: 0 })
  const [verified, setVerified] = useState(false)
  const [failed, setFailed] = useState(false)
  const [checking, setChecking] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const dragging = useRef<{ startX: number; base: number } | null>(null)
  // pointerup 里要读「最新」位移：state 有批处理延迟，同步事件里拿到的是旧值
  const offsetRef = useRef(0)
  const reloadTimer = useRef<number>(0)

  const load = useCallback(async () => {
    setVerified(false)
    setFailed(false)
    setOffset(0)
    onVerified(null)
    try {
      const r = await api.get('/api/auth/captcha', { skipHotel: true })
      if (!r?.enabled) {
        setEnabled(false)
        setQ(null)
        onEnabled?.(false)
        return
      }
      setEnabled(true)
      onEnabled?.(true)
      setQ({ id: r.id, bg: r.bg, piece: r.piece, y: r.y, width: r.width, height: r.height, size: r.size })
    } catch {
      // 出图失败不阻塞登录：后端会按「无票据」提示重新验证
      setQ(null)
      onEnabled?.(true)
    }
    // onVerified / onEnabled 由父组件按引用传入，不进依赖避免反复出图
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])

  useEffect(() => { load() }, [load])
  useEffect(() => () => window.clearTimeout(reloadTimer.current), [])

  // 实测渲染宽度：滑块与拼图块 1:1 跟随手指（同一坐标系），
  // 只受「拼图块不出背景右边界」约束；提交时用 位移/背景宽*逻辑宽 还原逻辑坐标。
  useEffect(() => {
    if (!q || !boxRef.current) return
    const calc = () => {
      const w = boxRef.current?.clientWidth || 0
      const pieceRendered = (q.size / q.width) * w
      setBounds({
        handleMax: Math.max(0, w - HANDLE - INSET * 2),
        pieceMax: Math.max(0, w - pieceRendered),
      })
    }
    calc()
    window.addEventListener('resize', calc)
    return () => window.removeEventListener('resize', calc)
  }, [q])

  // 拖动上限取两者较小值：滑块不出轨道、拼图块不出背景右边（缺口 x 上限 258/320，仍在范围内）
  const dragMax = Math.min(bounds.handleMax, bounds.pieceMax)
  const pieceLeft = Math.min(offset, bounds.pieceMax)

  const onPointerDown = (e: React.PointerEvent) => {
    if (verified || checking || !q) return
    e.preventDefault()
    try {
      // 指针捕获失败不影响拖动（部分环境/合成事件会抛 NotFoundError）
      ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    } catch { /* ignore */ }
    dragging.current = { startX: e.clientX, base: offsetRef.current }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return
    const next = Math.min(dragMax, Math.max(0, dragging.current.base + e.clientX - dragging.current.startX))
    offsetRef.current = next
    setOffset(next)
    if (failed) setFailed(false)
  }

  const fail = () => {
    setFailed(true)
    onVerified(null)
    offsetRef.current = 0
    setOffset(0)
    // 题目一次有效：失败后重新出图（延迟让抖动先播完）
    window.clearTimeout(reloadTimer.current)
    reloadTimer.current = window.setTimeout(() => load(), 600)
  }

  const onPointerUp = async () => {
    if (!dragging.current || !q) return
    dragging.current = null
    // 用 ref 里的最新位移（state 可能还没 flush，尤其 pointermove/up 同帧触发时）
    const current = offsetRef.current
    const renderedW = boxRef.current?.clientWidth || q.width
    const pieceMax = bounds.pieceMax || Math.max(0, renderedW - (q.size / q.width) * renderedW)
    const sentLeft = Math.min(current, pieceMax)
    const logical = Math.round((sentLeft / renderedW) * q.width)
    setChecking(true)
    try {
      const r = await api.post('/api/auth/captcha/verify', { id: q.id, x: logical }, { skipHotel: true })
      if (r?.ok && r.captcha_token) {
        setVerified(true)
        setFailed(false)
        onVerified(r.captcha_token)
      } else {
        fail()
      }
    } catch {
      fail()
    } finally {
      setChecking(false)
    }
  }

  if (!enabled) return null

  return (
    <div className={`captcha${failed ? ' captcha-fail' : ''}${verified ? ' captcha-ok' : ''}`}>
      <div className="captcha-bg" ref={boxRef} style={{ aspectRatio: q ? `${q.width} / ${q.height}` : '2 / 1' }}>
        {q && (
          <>
            <img src={q.bg} alt="拖动下方滑块完成拼图" draggable={false} />
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
            {verified && <span className="captcha-badge">验证通过</span>}
          </>
        )}
      </div>
      <div className="captcha-track">
        <div className="captcha-fill" style={{ width: offset + HANDLE + INSET * 2 }} />
        <span className="captcha-tip">
          {verified ? '验证通过' : failed ? '验证未通过，请重试' : checking ? '校验中…' : '按住滑块，拖动拼图'}
        </span>
        <button
          type="button"
          className="captcha-handle"
          style={{ transform: `translateX(${offset}px)` }}
          aria-label="滑动验证"
          disabled={verified || checking || !q}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => { dragging.current = null }}
        >
          {verified ? '✓' : '→'}
        </button>
      </div>
    </div>
  )
}
