import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { api, fmtMoney, mdt, type HourlyOvertimeItem } from './api'
import { useAuth } from './auth'

/**
 * 钟点房到时提醒卡：屏幕右下角常驻（全站第一个全局提醒面，AppShell 挂载）。
 * 数据 = GET /api/reservations/overtime 每 30s 轮询（延住/撤销入住/退房后自然退出列表）；
 * 行点击深链 /rooms 开该单详情抽屉（延住/退房/收款都在抽屉里，卡内不内嵌操作）——
 * 已在房态盘时 navigate 同路径携带 state，Rooms 的 location.state effect 照样开抽屉；
 * × 把当前列表计入「已忽略」（同批不再弹，新增到时房间会再次弹出；刷新重置）。
 * z-index 40 < overlay 50：抽屉/弹窗打开时弹卡被遮罩自然压住，关闭后弹卡仍在。
 */
function hhmm(iso: string): string {
  // "2026-11-23T14:00:00" → "11/23 14:00"
  return `${mdt(iso)} ${iso.slice(11, 16)}`
}

export default function OvertimeAlert() {
  const { activeHotelId } = useAuth()
  const nav = useNavigate()
  const [dismissed, setDismissed] = useState<Set<number>>(new Set())
  const q = useQuery({
    queryKey: ['hourly-overtime'],
    queryFn: () => api.get<HourlyOvertimeItem[]>('/api/reservations/overtime'),
    refetchInterval: 30_000,
    staleTime: 0,
    enabled: !!activeHotelId,
  })

  const items = (q.data ?? []).filter(x => !dismissed.has(x.reservation_id))
  const shown = items.length > 0
  // 首次出现才挂载（CSS 入场动画挂在 .show 上）；之后列表清空只是收起，不卸载节点
  const [mounted, setMounted] = useState(false)
  useEffect(() => { if (shown) setMounted(true) }, [shown])

  if (!mounted) return null
  return createPortal(
    <div className={`ot-pop${shown ? ' show' : ''}`} role="alert" aria-label="钟点房到时提醒">
      <div className="ot-head">
        <span className="ot-dot" />
        <span>钟点房到时 · {items.length} 间</span>
        <button
          type="button" className="ot-close" aria-label="关闭到时提醒"
          onClick={() => setDismissed(new Set((q.data ?? []).map(x => x.reservation_id)))}
        >
          <X size={14} strokeWidth={2.2} />
        </button>
      </div>
      <div className="ot-list">
        {items.map(x => (
          <button
            key={x.reservation_id} type="button" className="ot-item"
            onClick={() => nav('/rooms', { state: { openResId: x.reservation_id } })}
          >
            <span className="ot-r1">
              <span className="room">{x.room_number || '—'}</span>
              <span className="guest">{x.guest_name}{x.channel_name ? ` · ${x.channel_name}` : ''}</span>
              <span className="ot-chip">超时 {x.overtime_minutes} 分</span>
            </span>
            <span className="ot-r2">
              购买 {x.hours} 小时 · {hhmm(x.check_in_at)} 入住 · {hhmm(x.due_at)} 应退
              {x.balance_due > 0 ? ` · 欠款 ${fmtMoney(x.balance_due)}` : ''}
            </span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  )
}
