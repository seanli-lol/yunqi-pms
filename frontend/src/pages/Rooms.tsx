import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  api, addDaysIso, fmtMoney, md, todayIso, ROOM_STATUS_LABEL, OP_ACTION_LABEL, OP_ACTION_COLOR,
  type Board, type BoardRoom, type CalBlock, type Channel, type Folio, type OpLog,
  type RegistrationBody, type Reservation, type Room,
} from '../api'
import { Badge, Dialog, Field, PageHead, Segmented, Spinner, useToast, RES_STATUS_BADGE } from '../ui'
import { CheckInDialog, ExtendDialog } from '../dialogs'

const CELL = 88
const LAB_W = 150

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
  const [bookRoom, setBookRoom] = useState<{ room: Room; checkIn: string } | null>(null)
  const [checkinRes, setCheckinRes] = useState<Reservation | null>(null)
  /** 延住目标预订（详情弹层内「延住」按钮打开） */
  const [extendRes, setExtendRes] = useState<Reservation | null>(null)
  /** 编辑登记信息 / 撤销入住目标预订（详情弹层内打开） */
  const [editRes, setEditRes] = useState<Reservation | null>(null)
  const [undoRes, setUndoRes] = useState<Reservation | null>(null)
  /** 详情弹层内操作日志展开区 */
  const [showLogs, setShowLogs] = useState(false)
  /** 拖动中的房号 → 高亮目标行 */
  const [dragOverRoom, setDragOverRoom] = useState<number | null>(null)

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
    if (room.status === 'maintenance' || room.notes.includes('维修')) {
      toast(`${room.number} 维修中，暂不可预订`)
      return
    }
    if (!calRef.current) return
    const calRect = calRef.current.getBoundingClientRect()
    let col = Math.floor((e.clientX - calRect.left - LAB_W - 1) / CELL)
    col = Math.max(0, Math.min(13, col))
    const date = board.data?.day_list[col]?.date
    if (!date) return
    setVacantRoom(null)
    setDetailRes(null)
    setBookRoom({ room: { ...toRoom(room) }, checkIn: date })
  }

  /* ---------- 直接预订 ---------- */
  const bookMut = useMutation({
    mutationFn: (p: { guest_name: string; guest_phone: string; channel_id: number | null; notes: string; stay_type: 'normal' | 'hourly'; hours: number; rate: number | null }) =>
      api.post<Reservation>('/api/reservations', {
        guest_name: p.guest_name, guest_phone: p.guest_phone,
        room_id: bookRoom!.room.id,
        check_in: bookRoom!.checkIn,
        check_out: addDaysIso(bookRoom!.checkIn, 1),
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

  /* ---------- 撤销入住（入住反方向：退回已确认、删收款、房态转空脏） ---------- */
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

  // 撤销弹层要展示真实已收金额：取账目接口的 total_paid（不能用房价推算）
  const undoFolio = useQuery({
    queryKey: ['folio', undoRes?.id],
    enabled: undoRes !== null,
    queryFn: () => api.get<Folio>(`/api/reservations/${undoRes!.id}/folio`),
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
            <button className="btn btn-primary" onClick={() => setBookRoom({ room: allRooms[0], checkIn: todayIso() })}>新建预订</button>
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
                  onClick={() => { setBookRoom({ room: vacantRoom!, checkIn: todayIso() }); setVacantRoom(null) }}
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
                <button className="btn btn-danger-ghost" onClick={() => { if (window.confirm('确定取消该预订吗？')) resMut.mutate({ path: `${resQuery.data!.id}/cancel`, label: '预订已取消' }) }}>取消预订</button>
              )}
              {resQuery.data.status === 'pending' && (
                <button className="btn btn-ghost" onClick={() => resMut.mutate({ path: `${resQuery.data!.id}/confirm`, label: '预订已确认' })}>确认预订</button>
              )}
              {(resQuery.data.status === 'pending' || resQuery.data.status === 'confirmed') && (
                <button className="btn btn-primary" onClick={() => setCheckinRes(resQuery.data)}>办理入住</button>
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
            {resQuery.data.status === 'checked_in' && (
              <div className="sub-ops">
                <span className="hint">登记信息填错可「编辑登记」更正；撤销入住会把房态退回空脏，并删除本次入住产生的收款。</span>
                <button className="btn btn-danger-ghost btn-sm" onClick={() => { setUndoRes(resQuery.data!); setDetailRes(null) }}>撤销入住</button>
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
    </>
  )
}

/* ---------- 编辑在住登记信息（姓名 / 手机号 / 房价 / 来源 / 备注） ---------- */
function EditRegistrationDialog({ res, channels, busy, onClose, onConfirm }: {
  res: Reservation
  channels: Channel[]
  busy: boolean
  onClose: () => void
  onConfirm: (body: RegistrationBody) => void
}) {
  const [name, setName] = useState(res.guest_name)
  const [phone, setPhone] = useState(res.guest_phone)
  const [rateText, setRateText] = useState(String(res.rate))
  const [channelId, setChannelId] = useState<number | null>(res.channel_id)
  const [notes, setNotes] = useState(res.notes)

  const hourly = res.stay_type === 'hourly'
  const rate = Math.max(0, Math.round(Number(rateText) || 0))
  const units = hourly ? res.hours : res.nights
  const unitLabel = hourly ? '小时' : '晚'
  const total = units * rate

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
              rate, channel_id: channelId, notes,
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
        <Field
          label={`房价（元 / ${unitLabel}）`}
          hint={`修改后将按新房价重算该预订的房费账目（${units} ${unitLabel} × ¥${rate} = ¥${total.toLocaleString()}）。`}
        >
          <input
            className="input" inputMode="numeric" value={rateText}
            onChange={e => setRateText(e.target.value.replace(/[^\d]/g, ''))}
          />
        </Field>
        <Field label="预订来源">
          <select className="select" value={channelId ?? ''} onChange={e => setChannelId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">未指定</option>
            {channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label="备注">
        <input className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="如：高楼层、无烟房" />
      </Field>
      <p className="hint">保存后同步更新客户档案，并在预订日志留痕（操作人、修改前后内容）。</p>
    </Dialog>
  )
}

/* ---------- 撤销入住确认（入住反向：退回已确认、删收款、房态转空脏） ---------- */
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
        <span style={{ color: received > 0 ? 'var(--danger-deep)' : undefined }}>
          {paid === undefined ? '读取中…' : received > 0 ? `${fmtMoney(received)} · 撤销后删除（无退款凭证）` : '无收款'}
        </span>
      </div>
      <div className="danger-note">
        <b>撤销将立即生效，且不可自动恢复：</b>
        <ul>
          <li>房态退回「空脏」，需在房态盘点「设净」才能再次售卖；</li>
          <li>
            该预订的全部收款记录会被删除（{received > 0 ? `${fmtMoney(received)}，` : ''}
            余额回到 {fmtMoney(res.balance_due + received)}）；
          </li>
          <li>预订恢复为「已确认」，原锁定房号 {res.room_number ?? '—'} 仍保留；</li>
          <li>全程写入操作日志，可在预订详情「操作日志」中追溯。</li>
        </ul>
      </div>
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

/* ---------- 直接预订对话框 ---------- */
function BookDialog({ open, room, checkIn, channels, busy, onClose, onSubmit }: {
  open: boolean
  room?: Room
  checkIn?: string
  channels: Channel[]
  busy: boolean
  onClose: () => void
  onSubmit: (p: { guest_name: string; guest_phone: string; channel_id: number | null; notes: string; stay_type: 'normal' | 'hourly'; hours: number; rate: number | null }) => void
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [channelId, setChannelId] = useState<number | null>(null)
  /** 整晚 / 钟点：房型未配钟点价时隐藏钟点选项 */
  const [stayType, setStayType] = useState<'normal' | 'hourly'>('normal')
  const [hours, setHours] = useState(4)
  const [rateText, setRateText] = useState('')
  useEffect(() => {
    if (open) {
      setName(''); setPhone(''); setChannelId(null); setRateText('')
      setStayType('normal'); setHours(4)
    }
  }, [open])

  if (!room || !checkIn) return null
  const hourlyAvail = (room.hourly_price ?? 0) > 0
  const isHourly = stayType === 'hourly'
  const rate = rateText === '' ? null : Math.max(0, Math.round(Number(rateText) || 0))
  const showRate = isHourly || rateText !== ''
  const effPrice = rate ?? (isHourly ? room.hourly_price! : room.base_price)
  const summary = isHourly
    ? `钟点 ${hours} 小时 · ¥${effPrice}/小时 · 应收 ¥${(hours * effPrice).toLocaleString()}`
    : `1 晚 · ¥${effPrice}/晚`

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
            className="btn btn-primary" disabled={busy || !name.trim()}
            onClick={() => onSubmit({
              guest_name: name, guest_phone: phone, channel_id: channelId, notes: '',
              stay_type: stayType, hours: stayType === 'hourly' ? hours : 0,
              rate: showRate ? effPrice : null,
            })}
          >确认预订</button>
        </>
      }
    >
      <div className="book-room-summary">{room.room_number} · {room.room_type_name || '客房'} · {md(checkIn)} 入住 · {summary}</div>
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
            <button className={stayType === 'normal' ? 'active' : ''} onClick={() => setStayType('normal')}>整晚</button>
            <button className={stayType === 'hourly' ? 'active' : ''} onClick={() => setStayType('hourly')}>钟点</button>
          </div>
          <span className="hint">钟点价 ¥{room.hourly_price}/小时（设置 → 房型 中配置）；钟点房占用当日整天，创建后不可拖动改期。</span>
        </Field>
      )}
      {stayType === 'hourly' && (
        <Field label="入住时长">
          <div className="chips">
            {[2, 3, 4, 6, 8].map(x => (
              <button key={x} className={`chip${hours === x ? ' active' : ''}`} onClick={() => setHours(x)}>{x} 小时</button>
            ))}
          </div>
        </Field>
      )}
      <Field label="价格（选填，默认按系统设置价）" hint={showRate ? undefined : '留空则按 ¥' + (isHourly ? room.hourly_price : room.base_price) + (isHourly ? '/小时' : '/晚') + ' 计价。'}>
        <input className="input" inputMode="numeric" value={rateText}
               onChange={e => setRateText(e.target.value.replace(/[^\d]/g, ''))}
               placeholder={isHourly ? String(room.hourly_price) : String(room.base_price)} />
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
