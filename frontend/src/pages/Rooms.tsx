import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  api, addDaysIso, fmtMoney, md, todayIso, ROOM_STATUS_LABEL, OP_ACTION_LABEL, OP_ACTION_COLOR,
  type Board, type BoardRoom, type CalBlock, type Channel, type Folio, type OpLog,
  type PaidTotalBody, type RegistrationBody, type Reservation, type Room,
} from '../api'
import { Badge, Dialog, Field, PageHead, Segmented, Spinner, useToast, RES_STATUS_BADGE } from '../ui'
import { CheckInDialog, ExtendDialog } from '../dialogs'

const CELL = 88
const LAB_W = 150
const DAYS = 14

/** 房态 → 网格卡片样式类（与设计系统 components.css 的 .room-* 命名一致） */
const ROOM_CARD_CLS: Record<string, string> = {
  vacant_clean: 'room-clean',
  vacant_dirty: 'room-dirty',
  occupied: 'room-occupied',
  maintenance: 'room-maint',
}

interface DragState {
  block: CalBlock
  ghost: HTMLDivElement
  offsetX: number
}

/** 日历空白格按住横向拖选的多日范围（同一行 = 同一房间） */
interface CalSelection {
  roomId: number
  from: number
  to: number
}

export default function Rooms() {
  const toast = useToast()
  const qc = useQueryClient()
  const calRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  /** 刚完成拖动的门闩：松手后浏览器补发的 click 需要吞掉，避免误开弹层 */
  const justDraggedRef = useRef(false)

  const [view, setView] = useState<'cal' | 'grid'>('cal')
  const [start, setStart] = useState(addDaysIso(todayIso(), -2))
  const [detailRes, setDetailRes] = useState<Reservation | null>(null)
  const [vacantRoom, setVacantRoom] = useState<Room | null>(null)
  const [bookRoom, setBookRoom] = useState<{ room: Room; checkIn: string; nights: number } | null>(null)
  const [checkinRes, setCheckinRes] = useState<Reservation | null>(null)
  /** 延住目标预订（详情弹层内「延住」按钮打开） */
  const [extendRes, setExtendRes] = useState<Reservation | null>(null)
  /** 编辑登记信息 / 撤销入住 / 撤销退房 / 更正实收 / 调整预订 目标预订（详情弹层内打开） */
  const [editRes, setEditRes] = useState<Reservation | null>(null)
  const [undoRes, setUndoRes] = useState<Reservation | null>(null)
  const [undoOutRes, setUndoOutRes] = useState<Reservation | null>(null)
  const [paidRes, setPaidRes] = useState<Reservation | null>(null)
  const [adjustRes, setAdjustRes] = useState<Reservation | null>(null)
  /** 详情弹层内操作日志展开区 */
  const [showLogs, setShowLogs] = useState(false)
  /** 拖动中的房号 → 高亮目标行 */
  const [dragOverRoom, setDragOverRoom] = useState<number | null>(null)
  /** 日历拖选中的多日范围（松手后用于开单） */
  const [calSel, setCalSel] = useState<CalSelection | null>(null)

  const board = useQuery({
    queryKey: ['board', start],
    queryFn: () => api.get<Board>(`/api/rooms/board?start=${start}&days=14`),
    staleTime: 10_000,
  })
  const channels = useQuery({
    queryKey: ['channels'],
    queryFn: () => api.get<Channel[]>('/api/channels'),
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['board'] })
    qc.invalidateQueries({ queryKey: ['rooms'] })
    qc.invalidateQueries({ queryKey: ['dashboard'] })
  }

  const resQuery = useQuery({
    queryKey: ['reservation', detailRes?.id],
    enabled: detailRes !== null,
    queryFn: () => api.get<Reservation>(`/api/reservations/${detailRes!.id}`),
  })

  /* ---------- 拖动 ---------- */
  const onBlockPointerDown = (e: React.PointerEvent, block: CalBlock, room: BoardRoom) => {
    if (e.button !== 0) return
    e.preventDefault()
    // 方块拖动与行级「拖选多天」互斥：不让事件冒泡到 .cal-room
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    let moved = false
    let ghost: HTMLDivElement | null = null
    // grabOffset：指针相对方块原点的偏移，让幽灵块跟着手指走而不是中心吸附
    let grabDX = 0
    let grabDY = 0
    const el = document.querySelector(`.cal-block[data-res-id="${block.id}"]`) as HTMLElement | null
    if (!el) return

    const onMove = (ev: PointerEvent) => {
      if (!ghost) {
        if (Math.abs(ev.clientX - startX) < 5 && Math.abs(ev.clientY - startY) < 5) return
        moved = true
        const rect = el.getBoundingClientRect()
        grabDX = startX - rect.left
        grabDY = startY - rect.top
        el.style.opacity = '.35'
        ghost = el.cloneNode(true) as HTMLDivElement
        ghost.style.cssText += `position:fixed;z-index:99;pointer-events:none;margin:0;width:${el.offsetWidth}px;height:${rect.height}px;box-shadow:0 10px 30px rgba(0,0,0,.25);opacity:.92;`
        document.body.appendChild(ghost)
      }
      // 跟随指针：不用 transform（偏移大时 CSS transition 的 transform 会导致明显延迟）
      ghost.style.left = `${ev.clientX - grabDX}px`
      ghost.style.top = `${ev.clientY - grabDY}px`
      dragRef.current = { block, ghost, offsetX: 0 }

      // 指针下的目标行（幽灵块 pointer-events:none，不会挡住 elementFromPoint）
      const tRow = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.cal-room') as HTMLElement | null
      const hitId = tRow?.dataset.roomId
      setDragOverRoom(hitId ? Number(hitId) : null)
    }
    const onUp = (ev: PointerEvent) => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      ghost?.remove()
      el.style.opacity = ''
      setDragOverRoom(null)
      if (!moved) return
      // 任何拖动都吞掉紧随其后的 click
      justDraggedRef.current = true
      window.setTimeout(() => { justDraggedRef.current = false }, 350)
      if (!dragRef.current) return
      dragRef.current = null
      if (!calRef.current) return

      const calRect = calRef.current.getBoundingClientRect()
      let col = Math.floor((ev.clientX - calRect.left - LAB_W - 1) / CELL)
      col = Math.max(0, Math.min(13 - (block.nights - 1), col))
      const tRow = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.cal-room') as HTMLElement | null
      const lab = tRow?.querySelector('.cal-lab')?.textContent?.trim()

      // 找目标 room 对象
      let targetRoom: BoardRoom | null = null
      if (lab) {
        for (const g of board.data?.groups ?? []) {
          const hit = g.rooms.find(r => r.number === lab)
          if (hit) { targetRoom = hit; break }
        }
      }
      if (!targetRoom) return
      if (targetRoom.status === 'maintenance' || targetRoom.notes.includes('维修')) {
        toast('维修中的客房不可调入')
        return
      }
      // 钟点房：改日期才拦（后端同口径），纯换房放行（仍占整日）
      if (block.stay_type === 'hourly' && col !== block.col_start) {
        toast('钟点房预订不可改期，如需调整请延住或重新开单')
        return
      }
      if (targetRoom.id === room.id && col === block.col_start) return

      const newIn = (board.data?.day_list[col] ?? {}).date!
      const newOut = addDaysIso(newIn, block.nights)
      moveMut.mutate({
        id: block.id,
        body: { room_id: targetRoom.id, check_in: newIn, check_out: newOut },
        label: `${block.guest_name}：${room.number} → ${targetRoom.number}，${md(newIn)} 起 ${block.nights} 晚`,
      })
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  const moveMut = useMutation({
    mutationFn: (p: { id: number; body: { room_id: number; check_in: string; check_out: string }; label: string }) =>
      api.patch(`/api/reservations/${p.id}`, p.body),
    onSuccess: (_d, p) => toast(`已调整：${p.label}（演示环境实时生效）`),
    onError: (e: any) => toast(e.message ?? '调整失败'),
    onSettled: invalidate,
  })

  /* ---------- 点击空白格 → 直接预订 ---------- */
  const onCalClick = (e: React.MouseEvent, room: BoardRoom) => {
    if (justDraggedRef.current) return
    if ((e.target as HTMLElement).closest('.cal-block')) return
    // 房号标签区只显示房号 / 设净，不触发开单（曾因冒泡被夹到最左列误开单）
    if ((e.target as HTMLElement).closest('.cal-lab')) return
    if (room.status === 'maintenance' || room.notes.includes('维修')) {
      toast(`${room.number} 维修中，暂不可预订`)
      return
    }
    if (!calRef.current) return
    const date = board.data?.day_list[colAt(e.clientX)]?.date
    if (!date) return
    setVacantRoom(null)
    setDetailRes(null)
    setBookRoom({ room: { ...toRoom(room) }, checkIn: date, nights: 1 })
  }

  /** 指针 X 坐标 → 日历列号（0..13）。每次实时取 rect：日历在滚动容器内，缓存会错列。 */
  const colAt = (clientX: number) => {
    if (!calRef.current) return 0
    const calRect = calRef.current.getBoundingClientRect()
    const col = Math.floor((clientX - calRect.left - LAB_W - 1) / CELL)
    return Math.max(0, Math.min(DAYS - 1, col))
  }

  /* ---------- 按住空白格横向拖选多天 → 松手按选中天数开单 ---------- */
  const onCalPointerDown = (e: React.PointerEvent, room: BoardRoom) => {
    // 只支持鼠标（触屏/触控板保持单击开单，避免与滚动打架）
    if (e.button !== 0 || e.pointerType !== 'mouse') return
    const target = e.target as HTMLElement
    if (target.closest('.cal-block') || target.closest('.cal-lab') || target.closest('.cal-setclean')) return
    if (room.status === 'maintenance' || room.notes.includes('维修')) return

    const startCol = colAt(e.clientX)
    const startX = e.clientX
    const startY = e.clientY
    let active = false

    const onMove = (ev: PointerEvent) => {
      if (!active) {
        if (Math.abs(ev.clientX - startX) < 5 && Math.abs(ev.clientY - startY) < 5) return
        active = true
        setCalSel({ roomId: room.id, from: startCol, to: startCol })
      }
      setCalSel({ roomId: room.id, from: startCol, to: colAt(ev.clientX) })
    }
    const onUp = (ev: PointerEvent) => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      setCalSel(null)
      if (!active) return   // 纯点击：交给 onClick 按 1 晚开单
      // 拖选后浏览器会补发 click，复用拖动门闩吞掉
      justDraggedRef.current = true
      window.setTimeout(() => { justDraggedRef.current = false }, 350)

      const to = colAt(ev.clientX)
      const from = Math.min(startCol, to)
      const nights = Math.abs(to - startCol) + 1
      const date = board.data?.day_list[from]?.date
      if (!date) return
      setVacantRoom(null)
      setDetailRes(null)
      setBookRoom({ room: { ...toRoom(room) }, checkIn: date, nights })
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  /* ---------- 直接预订 ---------- */
  const bookMut = useMutation({
    mutationFn: (p: { guest_name: string; guest_phone: string; channel_id: number | null; notes: string; stay_type: 'normal' | 'hourly'; hours: number; rate: number | null; nights: number }) =>
      api.post<Reservation>('/api/reservations', {
        guest_name: p.guest_name, guest_phone: p.guest_phone,
        room_id: bookRoom!.room.id,
        check_in: bookRoom!.checkIn,
        check_out: addDaysIso(bookRoom!.checkIn, p.nights),
        channel_id: p.channel_id, notes: p.notes,
        stay_type: p.stay_type, hours: p.hours,
        rate: p.rate,
      }),
    onSuccess: (r) => {
      toast(`预订已创建：${r.code} · ${r.room_number}（${md(r.check_in)}–${md(r.check_out)}${r.stay_type === 'hourly' ? ` · 钟点 ${r.hours} 小时` : ''}）`)
      setBookRoom(null)
      invalidate()
    },
    onError: (e: any) => toast(e.message ?? '创建失败'),
  })

  /* ---------- 房态操作 ---------- */
  const statusMut = useMutation({
    mutationFn: (p: { room_id: number; status: string; label: string }) =>
      api.patch(`/api/rooms/${p.room_id}`, { status: p.status }),
    onSuccess: (_d, p) => { toast(p.label); invalidate() },
    onError: (e: any) => toast(e.message ?? '操作失败'),
  })

  /* ---------- 退房 / 延住 / 取消 ---------- */
  const resMut = useMutation({
    mutationFn: (p: { path: string; body?: any; label: string }) =>
      api.post(`/api/reservations/${p.path}`, p.body ?? {}),
    onSuccess: (_d, p) => {
      toast(p.label)
      setDetailRes(null)
      invalidate()
    },
    onError: (e: any) => toast(e.message ?? '操作失败'),
  })

  /* ---------- 办理入住（预订详情弹层内） ---------- */
  const checkinMut = useMutation({
    mutationFn: (p: { body: { room_id: number; amount_received: number; payment_method: string }; label: string }) =>
      api.post(`/api/reservations/${checkinRes!.id}/check-in`, p.body),
    onSuccess: (_d, p) => {
      toast(p.label)
      setCheckinRes(null)
      setDetailRes(null)
      invalidate()
    },
    onError: (e: any) => toast(e.message ?? '入住失败'),
  })

  /* ---------- 延住（详情弹层 / ExtendDialog） ---------- */
  const extendMut = useMutation({
    mutationFn: (p: { id: number; body: { nights: number; hours: number; rate: number } }) =>
      api.post(`/api/reservations/${p.id}/extend`, p.body),
    onSuccess: (_d, p) => {
      toast(p.body.hours > 0 ? `已延住 ${p.body.hours} 小时` : `已延住 ${p.body.nights} 晚，应收已追加到账单`)
      setExtendRes(null)
      setDetailRes(null)
      invalidate()
    },
    onError: (e: any) => toast(e.message ?? '延住失败'),
  })

  /* ---------- 编辑在住登记信息 ---------- */
  const editMut = useMutation({
    mutationFn: (p: { id: number; body: RegistrationBody }) =>
      api.patch<Reservation>(`/api/reservations/${p.id}/registration`, p.body),
    onSuccess: (r) => {
      toast('登记信息已更新，操作已留痕')
      setEditRes(null)
      setDetailRes(null)
      qc.invalidateQueries({ queryKey: ['reservation'] })
      invalidate()
    },
    onError: (e: any) => toast(e.message ?? '保存失败'),
  })

  /* ---------- 撤销入住（退回已确认、房态转空脏，收款保留） ---------- */
  const undoMut = useMutation({
    mutationFn: (p: { id: number; label: string }) =>
      api.post<Reservation>(`/api/reservations/${p.id}/undo-check-in`),
    onSuccess: (_d, p) => {
      toast(p.label)
      setUndoRes(null)
      setDetailRes(null)
      invalidate()
    },
    onError: (e: any) => toast(e.message ?? '撤销失败'),
  })

  /* ---------- 撤销退房（退回在住、房态恢复，收款保留） ---------- */
  const undoOutMut = useMutation({
    mutationFn: (p: { id: number; label: string }) =>
      api.post<Reservation>(`/api/reservations/${p.id}/undo-check-out`),
    onSuccess: (_d, p) => {
      toast(p.label)
      setUndoOutRes(null)
      setDetailRes(null)
      invalidate()
    },
    onError: (e: any) => toast(e.message ?? '撤销退房失败'),
  })

  /* ---------- 更正实收（整单已收总额） ---------- */
  const paidMut = useMutation({
    mutationFn: (p: { id: number; body: PaidTotalBody }) =>
      api.patch<Reservation>(`/api/reservations/${p.id}/paid-total`, p.body),
    onSuccess: () => {
      toast('实收总额已更正，操作已留痕')
      setPaidRes(null)
      qc.invalidateQueries({ queryKey: ['folio'] })
      invalidate()
    },
    onError: (e: any) => toast(e.message ?? '更正失败'),
  })

  /* ---------- 调整预订（待确认 / 已确认：改日期、天数、总价） ---------- */
  const adjustMut = useMutation({
    mutationFn: (p: { id: number; body: { check_in?: string; check_out?: string; rate: number } }) =>
      api.patch<Reservation>(`/api/reservations/${p.id}`, p.body),
    onSuccess: () => {
      toast('预订已调整，操作已留痕')
      setAdjustRes(null)
      qc.invalidateQueries({ queryKey: ['reservation'] })
      invalidate()
    },
    onError: (e: any) => toast(e.message ?? '调整失败'),
  })

  // 撤销弹层要展示真实已收金额：取账目接口的 total_paid（不能用房价推算）
  const undoFolio = useQuery({
    queryKey: ['folio', undoRes?.id],
    enabled: undoRes !== null,
    queryFn: () => api.get<Folio>(`/api/reservations/${undoRes!.id}/folio`),
  })

  // 详情弹层展示「已收 / 撤销退房弹层 / 更正实收」都依赖账目
  const detailFolio = useQuery({
    queryKey: ['folio', detailRes?.id],
    enabled: detailRes !== null,
    queryFn: () => api.get<Folio>(`/api/reservations/${detailRes!.id}/folio`),
  })
  const undoOutFolio = useQuery({
    queryKey: ['folio', undoOutRes?.id],
    enabled: undoOutRes !== null,
    queryFn: () => api.get<Folio>(`/api/reservations/${undoOutRes!.id}/folio`),
  })
  const paidFolio = useQuery({
    queryKey: ['folio', paidRes?.id],
    enabled: paidRes !== null,
    queryFn: () => api.get<Folio>(`/api/reservations/${paidRes!.id}/folio`),
  })

  /* ---------- 预订操作日志（详情弹层展开区，懒加载） ---------- */
  const logsQuery = useQuery({
    queryKey: ['reservation-logs', detailRes?.id],
    enabled: detailRes !== null && showLogs,
    queryFn: () => api.get<OpLog[]>(`/api/reservations/${detailRes!.id}/logs`),
  })

  /* ---------- 渲染 ---------- */
  if (board.isLoading || !board.data) return <Spinner />
  const bd = board.data
  const channelList = channels.data ?? []

  const allRooms: Room[] = bd.groups.flatMap(g => g.rooms.map(r => toRoom(r)))
  const gridGroups: Record<number, BoardRoom[]> = {}
  for (const g of bd.groups) gridGroups[g.room_type_id] = g.rooms

  return (
    <>
      <PageHead
        title="房态盘"
        desc="日历视图默认展示 · 拖动方块换房/改期 · 点击空白格直接开单"
        actions={
          <>
            <button className="btn btn-ghost" onClick={() => window.location.assign('/settings')}>来源渠道</button>
            <button className="btn btn-primary" onClick={() => setBookRoom({ room: allRooms[0], checkIn: todayIso(), nights: 1 })}>新建预订</button>
          </>
        }
      />

      <div className="filter-bar">
        <Segmented
          value={view}
          options={[{ key: 'cal', label: '日历' }, { key: 'grid', label: '单日网格' }]}
          onChange={setView}
        />
        <div className="cal-src-legend">
          {channelList.map(c => <span key={c.id}><i style={{ background: c.color }} />{c.name}</span>)}
          <a className="card-link" style={{ fontSize: 12.5, cursor: 'pointer' }} onClick={() => window.location.assign('/settings')}>配置颜色与顺序</a>
        </div>
        <div className="page-actions" style={{ marginLeft: 'auto' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setStart(addDaysIso(start, -1))}>‹ 前一天</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setStart(addDaysIso(todayIso(), -2))}>今天</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setStart(addDaysIso(start, 1))}>后一天 ›</button>
        </div>
      </div>

      {view === 'cal' ? (
        <div>
      <div className="cal-scroll">
        <div className="cal" ref={calRef}>
          <div className="cal-row cal-head">
            <div className="cal-corner">
              <span className="t">{md(bd.start)} – {md(bd.day_list[bd.day_list.length - 1].date)}</span>
              <span className="d">14 天 · 今天 {md(todayIso())} 周{bd.day_list[bd.day_list.length - 1].weekday}</span>
            </div>
            {bd.day_list.map(d => (
              <div key={d.date} className={`cal-h${d.is_today ? ' today' : ''}${['五', '六'].includes(d.weekday) ? ' wknd' : ''}`}>
                <span className="dt">{d.is_today ? '今天' : md(d.date)}</span>
                <span className="wk">{d.weekday}</span>
              </div>
            ))}
          </div>
          <div className="cal-row cal-remain">
            <div className="rl">可售余量</div>
            {bd.remain.map((n, i) => <div key={i} className="rc"><b>{n}</b>间</div>)}
          </div>

          {bd.groups.map(g => (
            <div key={g.room_type_id}>
              <div className="cal-row"><div className="cal-group">{g.name} · {g.rooms[0]?.floor}F<span className="c">{g.rooms.length} 间</span></div></div>
              {g.rooms.map(room => (
                <div
                  key={room.id}
                  data-room-id={room.id}
                  className={`cal-row cal-room${dragOverRoom === room.id ? ' drag-over' : ''}`}
                  onPointerDown={(e) => onCalPointerDown(e, room)}
                  onClick={(e) => onCalClick(e, room)}
                >
                  <div className={`cal-lab${room.status === 'vacant_dirty' ? ' dirty' : room.status === 'maintenance' ? ' maint' : ''}`}>
                    {room.number}
                    {(room.status === 'vacant_dirty' || room.status === 'maintenance') && (
                      <button
                        className="cal-setclean"
                        title={room.status === 'maintenance' ? '完成维修并设为净房' : '已退房 / 待清洁：点击设为净房'}
                        onClick={(e) => {
                          e.stopPropagation()
                          statusMut.mutate({
                            room_id: room.id, status: 'vacant_clean',
                            label: `${room.number} 已设为净房${room.status === 'maintenance' ? '（维修完成）' : ''}`,
                          })
                        }}
                      >设净</button>
                    )}
                  </div>
                  {room.status === 'maintenance' || room.notes.includes('维修') ? (
                    <div className="cal-maint">维修{room.notes ? ` · ${room.notes}` : ''}</div>
                  ) : (
                    room.blocks.map(b => {
                      const cls = b.status === 'checked_in' ? 'stay'
                        : b.status === 'checked_out' ? 'past' : 'future'
                      const hourly = b.stay_type === 'hourly'
                      return (
                        <div
                          key={b.id}
                          className={`cal-block ${cls}${hourly ? ' hourly' : ''}`}
                          data-res-id={b.id}
                          style={{ gridColumn: `${b.col_start + 2} / span ${b.nights}`, ['--src' as any]: b.channel_color }}
                          onPointerDown={(e) => onBlockPointerDown(e, b, room)}
                          onClick={() => {
                            if (justDraggedRef.current) return
                            setDetailRes({ id: b.id } as Reservation)
                          }}
                        >
                          <span className="g">{b.guest_name}{hourly ? ' · 钟点' : ''}</span>
                          <span className="s">{hourly ? `${b.hours ?? 0} 小时` : b.channel_name}</span>
                          {(b.status === 'checked_in' || b.status === 'checked_out') && b.balance_due > 0 && <span className="owe">欠</span>}
                        </div>
                      )
                    })
                  )}
                  {calSel && calSel.roomId === room.id && (
                    <div
                      className="cal-select"
                      style={{
                        gridColumn: `${Math.min(calSel.from, calSel.to) + 2} / span ${Math.abs(calSel.to - calSel.from) + 1}`,
                      }}
                    >{Math.abs(calSel.to - calSel.from) + 1} 晚</div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
          <p className="hint mt-16">
            图例：<Badge color="blue">在住</Badge> <Badge color="orange">未来抵店</Badge> <Badge color="red">欠</Badge> 在住/已离店未结清 ·
            方块最前端竖条颜色 = 预订来源（可在「设置 → 来源渠道」配置）。<b>拖动方块换房/改期（冲突自动回弹）· 点击空白格直接开单</b>。
          </p>
        </div>
      ) : (
        /* ---------- 单日网格 ---------- */
        <div>
          <div className="filter-bar">
            <div className="legend">
              <span><i className="lg-clean" />空净 · 可售</span>
              <span><i className="lg-dirty" />空脏 · 待清洁</span>
              <span><i className="lg-occupied" />在住</span>
              <span><i className="lg-maint" />维修</span>
            </div>
          </div>
          <div className="board">
            {bd.groups.map(g => {
              const byFloor = new Map<number, BoardRoom[]>()
              g.rooms.forEach(r => {
                if (!byFloor.has(r.floor)) byFloor.set(r.floor, [])
                byFloor.get(r.floor)!.push(r)
              })
              return [...byFloor.entries()].map(([floor, list]) => {
                const occ = list.filter(r => r.status === 'occupied').length
                const clean = list.filter(r => r.status === 'vacant_clean').length
                return (
                  <div key={`${g.room_type_id}-${floor}`} className="floor-row">
                    <div className="floor-label">
                      <div className="f">{floor}F</div>
                      <div className="c">{occ} 住 · {clean} 净</div>
                    </div>
                    <div className="rooms">
                      {list.map(r => (
                        <button
                          key={r.id}
                          className={`room ${ROOM_CARD_CLS[r.status] ?? ''}`}
                          onClick={() => {
                            if (r.status === 'occupied' && r.current_code) {
                              // 用 blocks 找到在住预订 → 详情
                              const blk = r.blocks.find(b => b.status === 'checked_in')
                              if (blk) setDetailRes({ id: blk.id } as Reservation)
                              else toast('该房间当前无在住预订')
                            } else {
                              setVacantRoom(toRoom(r))
                            }
                          }}
                        >
                          <span className="room-no">{r.number}</span>
                          <span className="room-meta">
                            {r.status === 'occupied'
                              ? `${r.current_guest ?? ''} · ${r.current_check_out ? md(r.current_check_out) : ''} 离`
                              : r.status === 'maintenance' ? `维修${r.notes ? ' · ' + r.notes : ''}`
                              : ROOM_STATUS_LABEL[r.status]}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )
              }).flat()
            })}
          </div>
        </div>
      )}

      {/* ---------- 直接预订弹层 ---------- */}
      <BookDialog
        open={bookRoom !== null}
        room={bookRoom?.room}
        checkIn={bookRoom?.checkIn}
        nights={bookRoom?.nights ?? 1}
        channels={channelList}
        busy={bookMut.isPending}
        onClose={() => setBookRoom(null)}
        onSubmit={(p) => bookMut.mutate(p)}
      />

      {/* ---------- 空房操作弹层 ---------- */}
      <Dialog
        open={vacantRoom !== null}
        onClose={() => setVacantRoom(null)}
        title={vacantRoom ? `${vacantRoom.room_number} · ${vacantRoom.room_type_name}` : ''}
        sub={vacantRoom ? `${vacantRoom.floor}楼 · ${ROOM_STATUS_LABEL[vacantRoom.status]}` : ''}
        foot={
          <>
            <span className="hint" style={{ marginRight: 'auto' }}>操作人：当前登录账号</span>
            {vacantRoom?.status === 'maintenance' ? (
              <button
                className="btn btn-primary"
                onClick={() => { statusMut.mutate({ room_id: vacantRoom.id, status: 'vacant_clean', label: `${vacantRoom.room_number} 维修完成，转为空净` }); setVacantRoom(null) }}
              >完成维修</button>
            ) : (
              <>
                <button
                  className="btn btn-ghost"
                  onClick={() => { statusMut.mutate({ room_id: vacantRoom!.id, status: 'maintenance', label: `${vacantRoom!.room_number} 已报维修` }); setVacantRoom(null) }}
                >报维修</button>
                {vacantRoom?.status === 'vacant_clean' && (
                  <button
                    className="btn btn-ghost"
                    onClick={() => { statusMut.mutate({ room_id: vacantRoom!.id, status: 'vacant_dirty', label: `${vacantRoom!.room_number} 已设为空脏（待清洁）` }); setVacantRoom(null) }}
                  >设为空脏</button>
                )}
                {vacantRoom?.status === 'vacant_dirty' && (
                  <button
                    className="btn btn-ghost"
                    onClick={() => { statusMut.mutate({ room_id: vacantRoom!.id, status: 'vacant_clean', label: `${vacantRoom!.room_number} 已设为净房` }); setVacantRoom(null) }}
                  >设为净房</button>
                )}
                <button
                  className="btn btn-primary"
                  onClick={() => { setBookRoom({ room: vacantRoom!, checkIn: todayIso(), nights: 1 }); setVacantRoom(null) }}
                >预订此房</button>
              </>
            )}
          </>
        }
      >
        {vacantRoom && (
          <>
            <div className="info-row"><span>房型</span><span>{vacantRoom.room_type_name}</span></div>
            <div className="info-row"><span>基准价</span><span>{fmtMoney(vacantRoom.base_price)} / 晚</span></div>
            <div className="info-row">
              <span>说明</span>
              <span>{vacantRoom.status === 'maintenance' ? '维修完成后点「完成维修」即可恢复可售' : vacantRoom.status === 'vacant_dirty' ? '该房可先预订，也可直接入住（记脏房入住）；整理后点「设为净房」' : '空净房可直接预订或办理入住'}</span>
            </div>
          </>
        )}
      </Dialog>

      {/* ---------- 预订详情弹层 ---------- */}
      <Dialog
        open={detailRes !== null}
        onClose={() => setDetailRes(null)}
        title={resQuery.data ? `${resQuery.data.room_number ?? '未分配'} · ${resQuery.data.room_type_name}` : '预订详情'}
        sub={resQuery.data ? `${RES_STATUS_BADGE[resQuery.data.status]?.label ?? resQuery.data.status} · ${resQuery.data.code}` : ''}
        foot={
          resQuery.data ? (
            <>
              <span className="hint" style={{ marginRight: 'auto' }}>操作人：{resQuery.data.operator_name ?? '—'}</span>
              {(resQuery.data.status === 'pending' || resQuery.data.status === 'confirmed') && (
                <button className="btn btn-danger-ghost" onClick={() => { if (window.confirm('确定取消该预订吗？\n\n取消会清除该预订已收取的款项（不生成退款凭证），且不可恢复。')) resMut.mutate({ path: `${resQuery.data!.id}/cancel`, label: '预订已取消' }) }}>取消预订</button>
              )}
              {resQuery.data.status === 'pending' && (
                <button className="btn btn-ghost" onClick={() => resMut.mutate({ path: `${resQuery.data!.id}/confirm`, label: '预订已确认' })}>确认预订</button>
              )}
              {(resQuery.data.status === 'pending' || resQuery.data.status === 'confirmed') && (
                <>
                  <button
                    className="btn btn-ghost"
                    onClick={() => { setAdjustRes(resQuery.data!); setDetailRes(null) }}
                  >调整预订</button>
                  {resQuery.data.check_in <= todayIso() ? (
                    <button className="btn btn-primary" onClick={() => setCheckinRes(resQuery.data)}>办理入住</button>
                  ) : null}
                </>
              )}
              {resQuery.data.status === 'checked_out' && resQuery.data.room_id && resQuery.data.room_status === 'vacant_dirty' && (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    statusMut.mutate({
                      room_id: resQuery.data!.room_id!, status: 'vacant_clean',
                      label: `${resQuery.data!.room_number} 已转为净房`,
                    })
                    setDetailRes(null)
                  }}
                >转为净房</button>
              )}
              {resQuery.data.status === 'checked_in' && (
                <>
                  <button
                    className="btn btn-ghost"
                    onClick={() => { setEditRes(resQuery.data!); setDetailRes(null) }}
                  >编辑登记</button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => setExtendRes(resQuery.data)}
                  >延住</button>
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      const r = resQuery.data!
                      api.post(`/api/reservations/${r.id}/check-out`, { force: false, payments: [] })
                        .then((x: any) => { toast('退房完成，房态转空脏'); setDetailRes(null); invalidate() })
                        .catch((e: any) => {
                          if (e.status === 409) {
                            const bal = e.data?.detail?.balance_due ?? 0
                            if (window.confirm(`存在未结清账款 ${fmtMoney(bal)}，确定强制退房吗？`)) {
                              api.post(`/api/reservations/${r.id}/check-out`, { force: true })
                                .then(() => { toast('已强制退房（未结清转挂账）'); setDetailRes(null); invalidate() })
                            }
                          } else toast(e.message)
                        })
                    }}
                  >办理退房</button>
                </>
              )}
            </>
          ) : null
        }
      >
        {resQuery.data && (
          <>
            <div className="info-row"><span>当前住客</span><span>{resQuery.data.guest_name} {resQuery.data.vip_level && <Badge color="purple">{resQuery.data.vip_level}</Badge>}</span></div>
            <div className="info-row"><span>联系电话</span><span>{resQuery.data.guest_phone || '未留'}</span></div>
            <div className="info-row">
              <span>住期</span>
              <span>{md(resQuery.data.check_in)} – {md(resQuery.data.check_out)} · {resQuery.data.stay_type === 'hourly' ? `钟点 ${resQuery.data.hours} 小时` : `共 ${resQuery.data.nights} 晚`}</span>
            </div>
            <div className="info-row"><span>房价</span><span>{fmtMoney(resQuery.data.rate)}{resQuery.data.stay_type === 'hourly' ? ' / 小时' : ' / 晚'}</span></div>
            <div className="info-row">
              <span>预订来源</span>
              <span>
                {resQuery.data.channel_color && <span className="dot" style={{ background: resQuery.data.channel_color, display: 'inline-block', verticalAlign: 1, marginRight: 6 }} />}
                {resQuery.data.channel_name ?? '—'}
              </span>
            </div>
            <div className="info-row">
              <span>已收（含押金）</span>
              <span>{detailFolio.data ? fmtMoney(detailFolio.data.total_paid) : '读取中…'}</span>
            </div>
            <div className="info-row">
              <span>账单余额</span>
              <span>
                {(resQuery.data.status === 'pending' || resQuery.data.status === 'confirmed')
                  ? resQuery.data.balance_due > 0
                    ? `房费待收 ${fmtMoney(resQuery.data.balance_due)}（到店结清）`
                    : '已结清'
                  : resQuery.data.balance_due > 0
                    ? <span className="amount-due">未结清 {fmtMoney(resQuery.data.balance_due)}</span>
                    : '已结清'}
              </span>
            </div>
            {resQuery.data.notes && <div className="info-row"><span>备注</span><span>{resQuery.data.notes}</span></div>}
            {(resQuery.data.status === 'pending' || resQuery.data.status === 'confirmed') && resQuery.data.check_in > todayIso() && (
              <div className="info-row">
                <span>到店提示</span>
                <span>未来抵店 · 当前仅可预订，{md(resQuery.data.check_in)} 当天方可办理入住</span>
              </div>
            )}
            {resQuery.data.status === 'checked_out' && (
              <div className="info-row">
                <span>房态</span>
                <span>
                  {resQuery.data.room_status === 'vacant_clean' ? '空净 · 可售'
                    : resQuery.data.room_status === 'vacant_dirty' ? '空脏 · 待清洁（可在下方转为净房）'
                    : resQuery.data.room_status === 'maintenance' ? '维修中'
                    : resQuery.data.room_status === 'occupied' ? '在住' : '—'}
                </span>
              </div>
            )}

            {/* 低频/危险操作区：与主流程按钮分开放，避免误触（版式同原型 .sub-ops） */}
            {(resQuery.data.status === 'checked_in' || resQuery.data.status === 'checked_out') && (
              <div className="sub-ops">
                <span className="hint">
                  {resQuery.data.status === 'checked_in'
                    ? '登记信息填错可「编辑登记」更正；「编辑实收」可按整单总额更正已收款；撤销入住会把房态退回空脏，已收款保留（取消预订时才清除）。'
                    : '退房登记有误可「更正实收」；「撤销退房」回到在住状态，已收款保留。'}
                </span>
                <button className="btn btn-ghost btn-sm" onClick={() => { setPaidRes(resQuery.data!); setDetailRes(null) }}>
                  {resQuery.data.status === 'checked_in' ? '编辑实收' : '更正实收'}
                </button>
                {resQuery.data.status === 'checked_in' && (
                  <button className="btn btn-danger-ghost btn-sm" onClick={() => { setUndoRes(resQuery.data!); setDetailRes(null) }}>撤销入住</button>
                )}
                {resQuery.data.status === 'checked_out' && (
                  <button className="btn btn-danger-ghost btn-sm" onClick={() => { setUndoOutRes(resQuery.data!); setDetailRes(null) }}>撤销退房</button>
                )}
              </div>
            )}

            {/* ---------- 操作日志展开区 ---------- */}
            <div className="oplog-toggle" onClick={() => setShowLogs(v => !v)}>
              <span>操作日志（本预订全部留痕）</span>
              <span className="arr">{showLogs ? '▴ 收起' : '▾ 展开'}</span>
            </div>
            {showLogs && (
              <div className="oplog-list">
                {logsQuery.isLoading && <div className="muted" style={{ padding: '8px 0' }}>加载中…</div>}
                {logsQuery.data?.length === 0 && <div className="muted" style={{ padding: '8px 0' }}>暂无操作记录</div>}
                {(logsQuery.data ?? []).map(o => (
                  <div key={o.id} className="oplog-row">
                    <span className="t">{o.time}</span>
                    <Badge color={OP_ACTION_COLOR[o.action] ?? 'gray'}>{OP_ACTION_LABEL[o.action] ?? o.action}</Badge>
                    <span className="s">{o.summary}</span>
                    <span className="op">{o.operator}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Dialog>

      {/* ---------- 入住向导（预订详情内办理入住） ---------- */}
      {checkinRes && (
        <CheckInDialog
          res={checkinRes} busy={checkinMut.isPending}
          onClose={() => setCheckinRes(null)}
          onConfirm={(body, label) => checkinMut.mutate({ body, label })}
        />
      )}

      {/* ---------- 延住弹窗（预订详情内） ---------- */}
      {extendRes && (
        <ExtendDialog
          res={extendRes} busy={extendMut.isPending}
          onClose={() => setExtendRes(null)}
          onConfirm={(body) => extendMut.mutate({ id: extendRes.id, body })}
        />
      )}

      {/* ---------- 编辑登记信息（在住） ---------- */}
      {editRes && (
        <EditRegistrationDialog
          res={editRes} channels={channelList} busy={editMut.isPending}
          onClose={() => { setEditRes(null); setDetailRes(editRes) }}
          onConfirm={(body) => editMut.mutate({ id: editRes.id, body })}
        />
      )}

      {/* ---------- 撤销入住（在住） ---------- */}
      {undoRes && (
        <UndoCheckInDialog
          res={undoRes} paid={undoFolio.data?.total_paid} busy={undoMut.isPending}
          onClose={() => { setUndoRes(null); setDetailRes(undoRes) }}
          onConfirm={() => undoMut.mutate({
            id: undoRes.id,
            label: `已撤销 ${undoRes.guest_name} 的入住，房态转空脏`,
          })}
        />
      )}

      {/* ---------- 撤销退房（已退房 → 回到在住） ---------- */}
      {undoOutRes && (
        <UndoCheckOutDialog
          res={undoOutRes} paid={undoOutFolio.data?.total_paid} busy={undoOutMut.isPending}
          onClose={() => { setUndoOutRes(null); setDetailRes(undoOutRes) }}
          onConfirm={() => undoOutMut.mutate({
            id: undoOutRes.id,
            label: `已撤销 ${undoOutRes.guest_name} 的退房，状态回到在住`,
          })}
        />
      )}

      {/* ---------- 更正实收（在住 / 已退房） ---------- */}
      {paidRes && (
        <EditPaidDialog
          res={paidRes} folio={paidFolio.data} busy={paidMut.isPending}
          onClose={() => { setPaidRes(null); setDetailRes(paidRes) }}
          onConfirm={(body) => paidMut.mutate({ id: paidRes.id, body })}
        />
      )}

      {/* ---------- 调整预订（待确认 / 已确认） ---------- */}
      {adjustRes && (
        <EditReservationDialog
          res={adjustRes} busy={adjustMut.isPending}
          onClose={() => { setAdjustRes(null); setDetailRes(adjustRes) }}
          onConfirm={(body) => adjustMut.mutate({ id: adjustRes.id, body })}
        />
      )}
    </>
  )
}

/* ---------- 编辑在住登记信息（姓名 / 手机号 / 天数 / 房价总额 / 来源 / 备注） ---------- */
function EditRegistrationDialog({ res, channels, busy, onClose, onConfirm }: {
  res: Reservation
  channels: Channel[]
  busy: boolean
  onClose: () => void
  onConfirm: (body: RegistrationBody) => void
}) {
  const [name, setName] = useState(res.guest_name)
  const [phone, setPhone] = useState(res.guest_phone)
  const [nightsText, setNightsText] = useState(String(res.nights))
  /** 房价总额（整单）；单价按天数折算后提交 */
  const [totalText, setTotalText] = useState(String(res.rate * (res.stay_type === 'hourly' ? res.hours : res.nights)))
  const [channelId, setChannelId] = useState<number | null>(res.channel_id)
  const [notes, setNotes] = useState(res.notes)

  const hourly = res.stay_type === 'hourly'
  const nights = Math.max(1, Math.round(Number(nightsText) || 1))
  const units = hourly ? res.hours : nights
  const unitLabel = hourly ? '小时' : '晚'
  const total = Math.max(0, Math.round(Number(totalText) || 0))
  const unitPrice = units > 0 ? Math.round(total / units) : 0
  const finalTotal = unitPrice * units

  /** 改天数时按「折合单价」重算总额（用户口径：总额根据天数计算） */
  const onNightsChange = (v: string) => {
    const digits = v.replace(/[^\d]/g, '')
    setNightsText(digits)
    const n = Math.max(1, Math.round(Number(digits) || 1))
    const prevUnits = units || 1
    const prevUnit = Math.round(total / prevUnits) || res.rate
    setTotalText(String(n * prevUnit))
  }

  return (
    <Dialog
      open onClose={onClose}
      title="编辑登记信息"
      sub={`${res.room_number ?? '未分配'} · ${res.guest_name} · 已入住 ${md(res.check_in)} – ${md(res.check_out)}`}
      foot={
        <>
          <span className="hint" style={{ marginRight: 'auto' }}>操作人：当前登录账号</span>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary" disabled={busy || !name.trim()}
            onClick={() => onConfirm({
              guest_name: name, guest_phone: phone,
              ...(hourly ? {} : { nights }),
              rate: unitPrice, channel_id: channelId, notes,
            })}
          >保存修改</button>
        </>
      }
    >
      <div className="form-row">
        <Field label="客人姓名" required>
          <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="请输入姓名" />
        </Field>
        <Field label="手机号">
          <input className="input" value={phone} onChange={e => setPhone(e.target.value)} placeholder="可留空，到店时补录" />
        </Field>
      </div>
      <div className="form-row">
        {!hourly && (
          <Field label="入住天数" hint="改天数后离店日 = 入住日 + 天数，首条房费随之重算；延住追加的账目不动。">
            <input
              className="input" inputMode="numeric" value={nightsText}
              onChange={e => onNightsChange(e.target.value)}
            />
          </Field>
        )}
        <Field
          label="房价总额（整单，元）"
          hint={`折合 ¥${unitPrice}/${unitLabel}（${units} ${unitLabel}）· 最终应收 ¥${finalTotal.toLocaleString()}。`}
        >
          <input
            className="input" inputMode="numeric" value={totalText}
            onChange={e => setTotalText(e.target.value.replace(/[^\d]/g, ''))}
          />
        </Field>
      </div>
      <div className="form-row">
        <Field label="预订来源">
          <select className="select" value={channelId ?? ''} onChange={e => setChannelId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">未指定</option>
            {channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="备注">
          <input className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="如：高楼层、无烟房" />
        </Field>
      </div>
      <p className="hint">保存后同步更新客户档案，并在预订日志留痕（操作人、修改前后内容）。</p>
    </Dialog>
  )
}

/* ---------- 撤销入住确认（入住反向：退回已确认、房态转空脏，收款保留） ---------- */
function UndoCheckInDialog({ res, paid, busy, onClose, onConfirm }: {
  res: Reservation
  /** 该预订当前已收合计（账目接口 total_paid，未加载时 undefined） */
  paid?: number
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const received = paid ?? 0
  return (
    <Dialog
      open onClose={onClose}
      title="撤销入住"
      sub={`${res.room_number ?? '未分配'} · ${res.guest_name} · ${res.code}`}
      foot={
        <>
          <span className="hint" style={{ marginRight: 'auto' }}>操作人：当前登录账号</span>
          <button className="btn btn-ghost" onClick={onClose}>保留在住</button>
          <button className="btn btn-danger-ghost" disabled={busy || paid === undefined} onClick={onConfirm}>确认撤销入住</button>
        </>
      }
    >
      <div className="info-row"><span>撤销后退回状态</span><span>已确认（预订保留，可重新办理入住）</span></div>
      <div className="info-row"><span>房间房态</span><span>空脏 · 待清洁</span></div>
      <div className="info-row">
        <span>该预订已收款</span>
        <span>
          {paid === undefined ? '读取中…' : received > 0 ? `${fmtMoney(received)} · 保留（仅在取消预订时清除）` : '无收款'}
        </span>
      </div>
      <div className="danger-note">
        <b>撤销将立即生效，且不可自动恢复：</b>
        <ul>
          <li>房态退回「空脏」，需在房态盘点「设净」才能再次售卖；</li>
          <li>
            该预订的收款记录 {received > 0 ? `${fmtMoney(received)} ` : ''}原样保留，账单余额不变；
            需更正金额请用「编辑实收」；
          </li>
          <li>预订恢复为「已确认」，原锁定房号 {res.room_number ?? '—'} 仍保留；</li>
          <li>全程写入操作日志，可在预订详情「操作日志」中追溯。</li>
        </ul>
      </div>
    </Dialog>
  )
}

/* ---------- 撤销退房确认（已退房 → 在住，收款保留） ---------- */
function UndoCheckOutDialog({ res, paid, busy, onClose, onConfirm }: {
  res: Reservation
  paid?: number
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog
      open onClose={onClose}
      title="撤销退房"
      sub={`${res.room_number ?? '未分配'} · ${res.guest_name} · ${res.code}`}
      foot={
        <>
          <span className="hint" style={{ marginRight: 'auto' }}>操作人：当前登录账号</span>
          <button className="btn btn-ghost" onClick={onClose}>保持离店</button>
          <button className="btn btn-danger-ghost" disabled={busy || paid === undefined} onClick={onConfirm}>确认撤销退房</button>
        </>
      }
    >
      <div className="info-row"><span>撤销后退回状态</span><span>已入住（在住）</span></div>
      <div className="info-row"><span>房间房态</span><span>恢复在住（维修中则保持维修）</span></div>
      <div className="info-row">
        <span>已收款项</span>
        <span>{paid === undefined ? '读取中…' : paid > 0 ? `${fmtMoney(paid)} · 保留（不退款）` : '无收款'}</span>
      </div>
      <div className="danger-note">
        <b>撤销后客人回到在住：</b>
        <ul>
          <li>房态恢复为「在住」，可重新办理退房；</li>
          <li>已收款项原样保留，账单余额按现有账目重算，不生成退款；</li>
          <li>若该房间已安排新客入住，系统按「前客未退」并存，请先核实房间情况；</li>
          <li>全程写入操作日志，可在预订详情「操作日志」中追溯。</li>
        </ul>
      </div>
    </Dialog>
  )
}

/* ---------- 更正实收（把整单已收金额调整到目标总额） ---------- */
function EditPaidDialog({ res, folio, busy, onClose, onConfirm }: {
  res: Reservation
  folio?: Folio
  busy: boolean
  onClose: () => void
  onConfirm: (body: PaidTotalBody) => void
}) {
  const cur = folio?.total_paid ?? 0
  const charge = folio?.total_charge ?? 0
  const [amountText, setAmountText] = useState<string | null>(null)
  const [method, setMethod] = useState<'cash' | 'wechat' | 'alipay' | 'card'>('wechat')
  // 数据异步到达后用当前已收填充一次
  const value = amountText ?? (folio ? String(cur) : '')
  const amount = Math.max(0, Math.round(Number(value) || 0))
  const diff = amount - cur

  return (
    <Dialog
      open onClose={onClose}
      title="更正实收"
      sub={`${res.room_number ?? '未分配'} · ${res.guest_name} · ${res.code}`}
      foot={
        <>
          <span className="hint" style={{ marginRight: 'auto' }}>操作人：当前登录账号</span>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary" disabled={busy || !folio}
            onClick={() => onConfirm({ amount, method })}
          >保存修改</button>
        </>
      }
    >
      <div className="info-row"><span>应收（房费 + 杂费）</span><span>{folio ? fmtMoney(charge) : '读取中…'}</span></div>
      <div className="info-row"><span>当前已收</span><span>{folio ? fmtMoney(cur) : '读取中…'}</span></div>
      <Field
        label="已收总额（整单，元）"
        hint={folio
          ? `较当前 ${diff >= 0 ? '+' : '−'}${fmtMoney(Math.abs(diff))} · 保存后余额 = 应收 − 已收总额。`
          : '读取中…'}
      >
        <input
          className="input" inputMode="numeric" value={value}
          onChange={e => setAmountText(e.target.value.replace(/[^\d]/g, ''))}
        />
      </Field>
      <Field label="补收方式（增加时使用）">
        <select className="select" value={method} onChange={e => setMethod(e.target.value as any)}>
          <option value="wechat">微信</option><option value="alipay">支付宝</option>
          <option value="cash">现金</option><option value="card">刷卡</option>
        </select>
      </Field>
      <p className="hint warn">减少已收会冲减收款记录（从最新一笔起），不生成退款凭证；全过程写入预订日志。</p>
    </Dialog>
  )
}

/* ---------- 调整预订（待确认 / 已确认：入住日、天数、总价） ---------- */
function EditReservationDialog({ res, busy, onClose, onConfirm }: {
  res: Reservation
  busy: boolean
  onClose: () => void
  onConfirm: (body: { check_in?: string; check_out?: string; rate: number }) => void
}) {
  const hourly = res.stay_type === 'hourly'
  const [checkIn, setCheckIn] = useState(res.check_in)
  const [nightsText, setNightsText] = useState(String(res.nights))
  const [totalText, setTotalText] = useState(
    String(res.rate * (hourly ? res.hours : res.nights)),
  )

  const nights = Math.max(1, Math.round(Number(nightsText) || 1))
  const units = hourly ? res.hours : nights
  const unitLabel = hourly ? '小时' : '晚'
  const total = Math.max(0, Math.round(Number(totalText) || 0))
  const unitPrice = units > 0 ? Math.round(total / units) : 0
  const finalTotal = unitPrice * units

  /** 改天数时按折合单价重算总额 */
  const onNightsChange = (v: string) => {
    const digits = v.replace(/[^\d]/g, '')
    setNightsText(digits)
    const n = Math.max(1, Math.round(Number(digits) || 1))
    const prevUnit = Math.round(total / (units || 1)) || res.rate
    setTotalText(String(n * prevUnit))
  }

  return (
    <Dialog
      open onClose={onClose}
      title="调整预订"
      sub={`${res.room_number ?? res.room_type_name} · ${res.guest_name} · ${res.code}`}
      foot={
        <>
          <span className="hint" style={{ marginRight: 'auto' }}>操作人：当前登录账号</span>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary" disabled={busy}
            onClick={() => onConfirm(hourly
              // 钟点房占整日固定：只提交总价折算的单价，不携带日期（后端对改期显式 400）
              ? { rate: unitPrice }
              : { check_in: checkIn, check_out: addDaysIso(checkIn, nights), rate: unitPrice })}
          >保存修改</button>
        </>
      }
    >
      <div className="form-row">
        <Field label="入住日期" required>
          <input className="input" type="date" value={checkIn} onChange={e => setCheckIn(e.target.value)} />
        </Field>
        {!hourly ? (
          <Field label="入住天数" hint={`离店日 ${md(addDaysIso(checkIn, nights))}；房号锁定，冲突会提示。`}>
            <input className="input" inputMode="numeric" value={nightsText} onChange={e => onNightsChange(e.target.value)} />
          </Field>
        ) : (
          <Field label="钟点时长">
            <input className="input" value={`${res.hours} 小时`} disabled />
          </Field>
        )}
      </div>
      <Field
        label="房价总额（整单，元）"
        hint={`折合 ¥${unitPrice}/${unitLabel}（${units} ${unitLabel}）· 最终应收 ¥${finalTotal.toLocaleString()}。`}
      >
        <input
          className="input" inputMode="numeric" value={totalText}
          onChange={e => setTotalText(e.target.value.replace(/[^\d]/g, ''))}
        />
      </Field>
      <p className="hint">钟点房占整日固定，只能调整总价；改日期请重新开单或延住。</p>
    </Dialog>
  )
}

function toRoom(r: BoardRoom): Room {
  return {
    id: r.id, room_number: r.number, floor: r.floor, status: r.status,
    notes: r.notes, room_type_id: 0,
    room_type_name: r.room_type_name, base_price: r.base_price,
    hourly_price: r.hourly_price ?? 0,
  }
}

/* ---------- 直接预订对话框（天数 + 整单总额；单价由总额折算） ---------- */
function BookDialog({ open, room, checkIn, nights: defaultNights, channels, busy, onClose, onSubmit }: {
  open: boolean
  room?: Room
  checkIn?: string
  /** 默认入住天数：拖选多天时为选区长度，单击/按钮入口为 1 */
  nights: number
  channels: Channel[]
  busy: boolean
  onClose: () => void
  onSubmit: (p: { guest_name: string; guest_phone: string; channel_id: number | null; notes: string; stay_type: 'normal' | 'hourly'; hours: number; rate: number | null; nights: number }) => void
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [channelId, setChannelId] = useState<number | null>(null)
  /** 整晚 / 钟点：房型未配钟点价时隐藏钟点选项 */
  const [stayType, setStayType] = useState<'normal' | 'hourly'>('normal')
  const [hours, setHours] = useState(4)
  const [nightsText, setNightsText] = useState('1')
  /** 房价总额（整单）；单价按天数 / 小时数折算后提交 */
  const [totalText, setTotalText] = useState('')
  /** 上次折算出的单价：改天数时按它重算总额（用户口径：总额根据天数计算） */
  const [unitRef, setUnitRef] = useState<{ v: number }>({ v: room?.base_price ?? 0 })

  useEffect(() => {
    if (open && room) {
      setName(''); setPhone(''); setChannelId(null)
      setStayType('normal'); setHours(4)
      const n = Math.max(1, defaultNights)
      setNightsText(String(n))
      setTotalText(String(n * room.base_price))
      // 每次打开都从系统基准价开始折算，避免沿用上次的总额
      setUnitRef({ v: room.base_price })
    }
  }, [open, room, defaultNights])

  if (!room || !checkIn) return null
  const hourlyAvail = (room.hourly_price ?? 0) > 0
  const isHourly = stayType === 'hourly'
  const baseUnit = isHourly ? (room.hourly_price || 0) : room.base_price
  const units = isHourly ? hours : Math.max(1, Math.round(Number(nightsText) || 1))
  const unitLabel = isHourly ? '小时' : '晚'
  const total = Math.max(0, Math.round(Number(totalText) || 0))
  const unitPrice = units > 0 ? Math.round(total / units) : 0
  const finalTotal = unitPrice * units
  const checkOut = addDaysIso(checkIn, units)

  /** 改天数 / 时长：按上次折算单价重算总额 */
  const onUnitsChange = (next: number) => {
    const u = unitRef.v || baseUnit
    setTotalText(String(next * u))
  }
  /** 手改总额：折算单价记入 unitRef */
  const onTotalChange = (v: string) => {
    const digits = v.replace(/[^\d]/g, '')
    setTotalText(digits)
    const t = Math.max(0, Math.round(Number(digits) || 0))
    setUnitRef({ v: units > 0 ? Math.round(t / units) : baseUnit })
  }
  /** 切换整晚 / 钟点：总额重挂号型基准价 */
  const onStayTypeChange = (next: 'normal' | 'hourly') => {
    setStayType(next)
    const unit = next === 'hourly' ? (room.hourly_price || 0) : room.base_price
    setUnitRef({ v: unit })
    setTotalText(String((next === 'hourly' ? hours : Math.max(1, Math.round(Number(nightsText) || 1))) * unit))
  }

  return (
    <Dialog
      open={open} onClose={onClose}
      title="直接预订"
      sub="在房态盘选定房号，创建后该房间此时段即被锁定"
      foot={
        <>
          <span className="hint" style={{ marginRight: 'auto' }}>操作人：当前登录账号</span>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary" disabled={busy || !name.trim() || units <= 0}
            onClick={() => onSubmit({
              guest_name: name, guest_phone: phone, channel_id: channelId, notes: '',
              stay_type: stayType, hours: isHourly ? hours : 0,
              rate: unitPrice,
              nights: isHourly ? 1 : units,
            })}
          >确认预订</button>
        </>
      }
    >
      <div className="book-room-summary">
        {room.room_number} · {room.room_type_name || '客房'} · {md(checkIn)} 入住 · {isHourly
          ? `钟点 ${hours} 小时 · 折合 ¥${unitPrice}/小时 · 应收 ¥${finalTotal.toLocaleString()}`
          : `共 ${units} 晚（${md(checkOut)} 离店）· 折合 ¥${unitPrice}/晚 · 应收 ¥${finalTotal.toLocaleString()}`}
      </div>
      <div className="form-row">
        <Field label="客人姓名" required>
          <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="请输入姓名" />
        </Field>
        <Field label="手机号（选填）" hint="填写后用于接收确认短信；未填写则到店补录。">
          <input className="input" value={phone} onChange={e => setPhone(e.target.value)} placeholder="可留空，到店时补录" />
        </Field>
      </div>
      {hourlyAvail && (
        <Field label="入住方式">
          <div className="segmented">
            <button className={stayType === 'normal' ? 'active' : ''} onClick={() => onStayTypeChange('normal')}>整晚</button>
            <button className={stayType === 'hourly' ? 'active' : ''} onClick={() => onStayTypeChange('hourly')}>钟点</button>
          </div>
          <span className="hint">钟点价 ¥{room.hourly_price}/小时（设置 → 房型 中配置）；钟点房占用当日整天，创建后不可拖动改期。</span>
        </Field>
      )}
      {isHourly ? (
        <Field label="入住时长">
          <div className="chips">
            {[2, 3, 4, 6, 8].map(x => (
              <button
                key={x} className={`chip${hours === x ? ' active' : ''}`}
                onClick={() => { setHours(x); onUnitsChange(x) }}
              >{x} 小时</button>
            ))}
          </div>
        </Field>
      ) : (
        <Field label="入住天数" hint="按住日历空白格横向拖动可直接选多天；也可在这里改天数。">
          <input
            className="input" inputMode="numeric" value={nightsText}
            onChange={e => {
              const digits = e.target.value.replace(/[^\d]/g, '')
              setNightsText(digits)
              onUnitsChange(Math.max(1, Math.round(Number(digits) || 1)))
            }}
          />
        </Field>
      )}
      <Field
        label={`房价总额（整单，元）`}
        hint={`折合 ¥${unitPrice}/${unitLabel}（${units} ${unitLabel}）· 最终应收 ¥${finalTotal.toLocaleString()}；改天数时按折合单价自动重算总额。`}
      >
        <input
          className="input" inputMode="numeric" value={totalText}
          onChange={e => onTotalChange(e.target.value)}
          placeholder={String(units * baseUnit)}
        />
      </Field>
      <Field label="来源">
        <select className="select" value={channelId ?? ''} onChange={e => setChannelId(e.target.value ? Number(e.target.value) : null)}>
          {channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <span className="hint">选项与顺序来自「设置 → 来源渠道」配置。</span>
      </Field>
    </Dialog>
  )
}
