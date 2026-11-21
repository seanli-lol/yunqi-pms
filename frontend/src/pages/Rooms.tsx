import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, X } from 'lucide-react'
import {
  api, addDaysIso, fmtMoney, maskPhone, md, mdt, payMethodLabel, todayIso,
  ROOM_STATUS_LABEL, OP_ACTION_LABEL, OP_ACTION_COLOR,
  usePayMethods,
  type Board, type BoardRoom, type CalBlock, type Channel, type Folio, type OpLog,
  type PaidTotalBody, type RegistrationBody, type Reservation, type Room,
} from '../api'
import { Badge, ConfirmDialog, Dialog, Drawer, Field, PageHead, Segmented, Spinner, useToast, RES_STATUS_BADGE } from '../ui'
import { CheckInDialog, ExtendDialog } from '../dialogs'
import { GuestNameInput } from '../GuestNameInput'

/** 同房行内方块布局（评审定稿规则，design/prototype/rooms.html 同源）：
    ① 真方块（在住/未来/多晚存根）按列冲突贪心分轨——同列可证明 ≤2 笔，行高恒定；
    ② 当日入住当日退的窄存根（truncated + stub_nights==1，钟点房/当日往返）不画灰块，
       按退房日聚合为格角「退房」角标（不限笔数，10 笔也只占一枚角标位）。 */
function layoutRoomBlocks(blocks: CalBlock[]): {
  lanes: { b: CalBlock; span: number; track: number; lane: number }[]
  deps: { col: number; list: CalBlock[] }[]
} {
  const depMap = new Map<number, CalBlock[]>()
  const real: { b: CalBlock; span: number; track: number; lane: number }[] = []
  blocks.forEach(b => {
    if (b.truncated && b.stub_nights === 1 && b.status === 'checked_out') {
      const arr = depMap.get(b.col_start) ?? []
      arr.push(b)
      depMap.set(b.col_start, arr)
      return
    }
    const span = b.truncated ? (b.stub_nights ?? 0) : b.nights
    if (span <= 0) return // 存根整段窗外：无可视部分（「可售」虚纹已退役，空白即可售）
    real.push({ b, span, track: 0, lane: 0 })
  })
  const occupied: Array<Array<[number, number]>> = []
  real.sort((x, y) => x.b.col_start - y.b.col_start)
  real.forEach(item => {
    const s = item.b.col_start
    const e = s + item.span - 1
    // 贪心占轨：进第一条与 [s,e] 无冲突的轨（轨内方块互不重叠），全部冲突才开新轨。
    // 不能写成「找到有冲突的轨就挤进去」——那样前后脚不重叠的预订会被排进新轨
    // 压成 20px 小块，而真正同列重叠的两笔反而挤进同轨叠在一起。
    let track = occupied.findIndex(tracks => tracks.every(([ls, le]) => e < ls || s > le))
    if (track < 0) {
      occupied.push([[s, e]])
      track = occupied.length - 1
    } else {
      occupied[track].push([s, e])
    }
    item.track = track
  })
  // 轨位 → 视觉 lane：0=整行 42px；1=上轨 lane-1；2=下轨 lane-2（lane 取值与 CSS 类名对应）。
  // 同列存在异轨邻居的方块必须压进轨带（20px），否则 42px 方块会与下轨叠画；
  // 前后脚退住、列上无邻居的孤块保持整行（203 周婷今退 + 张三明入 ≠ 重叠）。
  // 同列可证明 ≤2 笔，track ≥2 仅兜底（cap 到下轨）。
  real.forEach(item => {
    const s = item.b.col_start
    const e = s + item.span - 1
    const paired = real.some(o =>
      o !== item && o.track !== item.track &&
      o.b.col_start <= e && s <= o.b.col_start + o.span - 1)
    item.lane = item.track > 0 ? Math.min(item.track + 1, 2) : paired ? 1 : 0
  })
  return {
    lanes: real,
    deps: [...depMap.entries()].sort((a, b) => a[0] - b[0]).map(([col, list]) => ({ col, list })),
  }
}

/** 退房角标明细卡的状态包（anchor 用于跟随定位） */
interface DepInfo { roomNo: string; day: string; deps: CalBlock[]; anchor: HTMLElement }

/** 日历房号列/日期列的设计基准宽度；宽屏下列宽被 CSS 1fr 拉伸，仅作兜底（见 calGeom） */
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

/** 多房预订中的一行：一间房 × 一段住期（总额口径，单价折算提交） */
interface BookingLine {
  room: Room
  checkIn: string
  nights: number
  /** 行整单总额文本；默认 nights × base_price，可手改 */
  totalText: string
  /** 手改总额时折算出的单价（改天数时按它重算总额），null = 未手改 */
  unitRef: number | null
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
  /** 多房预订：null = 关闭；lines 可累积多间（点空白格/拖选追加） */
  const [booking, setBooking] = useState<{ lines: BookingLine[] } | null>(null)
  const [checkinRes, setCheckinRes] = useState<Reservation | null>(null)
  /** 延住目标预订（详情抽屉内「延住」菜单项打开） */
  const [extendRes, setExtendRes] = useState<Reservation | null>(null)
  /** 编辑登记信息 / 撤销入住 / 撤销退房 / 更正实收 / 调整预订 目标预订（详情抽屉内打开） */
  const [editRes, setEditRes] = useState<Reservation | null>(null)
  const [undoRes, setUndoRes] = useState<Reservation | null>(null)
  const [undoOutRes, setUndoOutRes] = useState<Reservation | null>(null)
  const [paidRes, setPaidRes] = useState<Reservation | null>(null)
  // 退房角标明细卡：anchor 定位 + 钉住（点角标后移开鼠标不消失）；行点击直接开订单详情抽屉
  const [dep, setDep] = useState<DepInfo | null>(null)
  const [depPinned, setDepPinned] = useState(false)
  const depRef = useRef<HTMLDivElement | null>(null)
  const depHideTimer = useRef(0)
  const depPinnedRef = useRef(false)
  depPinnedRef.current = depPinned
  const [adjustRes, setAdjustRes] = useState<Reservation | null>(null)
  /** 订单详情抽屉：双 tab（详情/操作日志）+ 折叠账目 + 收款小弹层 */
  const [orderTab, setOrderTab] = useState<'detail' | 'logs'>('detail')
  const [payFoldOpen, setPayFoldOpen] = useState(true)
  const [otherFoldOpen, setOtherFoldOpen] = useState(false)
  const [payAdd, setPayAdd] = useState(false)
  /** 应用内确认弹层（替代 window.confirm）：删除收款 / 取消预订 / 强制退房 */
  const [delPay, setDelPay] = useState<{ rid: number; pay: Folio['payments'][number] } | null>(null)
  const [cancelRes, setCancelRes] = useState<Reservation | null>(null)
  const [forceOut, setForceOut] = useState<{ id: number; bal: number } | null>(null)
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
  // 订单详情收款表展示名 / 收款弹层下拉共用（react-query 同 key 去重，与 EditDrawer/BookDrawer 共享缓存）
  const pms = usePayMethods()

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['board'] })
    qc.invalidateQueries({ queryKey: ['rooms'] })
    qc.invalidateQueries({ queryKey: ['dashboard'] })
    // 详情与账目一并失效：入住/退房/延住后重新点开方块必须看到最新状态
    // （曾只失效 board，入住后 15s 内再点方块仍显示「已确认 + 办理入住」，被当成「当天不能退房」）
    qc.invalidateQueries({ queryKey: ['reservation'] })
    qc.invalidateQueries({ queryKey: ['folio'] })
  }

  const resQuery = useQuery({
    queryKey: ['reservation', detailRes?.id],
    enabled: detailRes !== null,
    queryFn: () => api.get<Reservation>(`/api/reservations/${detailRes!.id}`),
    // 每次打开抽屉都取最新状态：命中 15s 全局 staleTime 会让刚办的入住/退房不可见
    staleTime: 0,
  })

  /* ---------- 拖动 ---------- */
  /** 表单类抽屉（入住/延住/编辑登记/撤销/更正实收/调整）打开中：日历点击一律忽略，防误触丢表单 */
  const formDrawerOpen = () => !!(checkinRes || extendRes || editRes || undoRes || undoOutRes || paidRes || adjustRes)

  /* ---------- 退房角标明细卡 ---------- */
  const closeDep = useCallback(() => { setDep(null); setDepPinned(false) }, [])
  const hideDepSoon = () => {
    window.clearTimeout(depHideTimer.current)
    depHideTimer.current = window.setTimeout(() => { if (!depPinnedRef.current) closeDep() }, 120)
  }
  const cancelDepHide = () => window.clearTimeout(depHideTimer.current)
  const openDep = (roomNo: string, col: number, list: CalBlock[], anchor: HTMLElement) => {
    cancelDepHide()
    setDep({ roomNo, day: md(board.data?.day_list[col]?.date ?? ''), deps: list, anchor })
  }
  const toggleDep = (roomNo: string, col: number, list: CalBlock[], anchor: HTMLElement) => {
    if (dep && dep.anchor === anchor) {
      if (depPinned) closeDep(); else setDepPinned(true)   // 再点角标：钉住 → 收起
    } else {
      openDep(roomNo, col, list, anchor)
      setDepPinned(true)                                   // 点角标：钉住展开（触屏同此路径）
    }
  }
  // Esc / 点外部 / 页面滚动 → 收起（卡内明细列表滚动除外，否则浏览 10 笔时卡片会凭空消失）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDep() }
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (depRef.current?.contains(t) || t.closest('.cal-dep')) return
      closeDep()
    }
    const onScroll = (e: Event) => {
      if (depRef.current?.contains(e.target as Node)) return
      closeDep()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('click', onClick)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('click', onClick)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [closeDep])
  // 每次渲染按锚点重定位：贴右缘夹取、底部溢出翻转到锚点上方
  useEffect(() => {
    const el = depRef.current
    if (!el || !dep) return
    const r = dep.anchor.getBoundingClientRect()
    const left = Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 12))
    let top = r.bottom + 6
    if (top + el.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - el.offsetHeight - 6)
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  })

  /** 日历实际几何：宽屏下日期列被 1fr 拉伸（房态盘去留白后铺满主区），
      列号换算必须实测 .cal-lab/.cal-h 宽度——写死 88/150 会错列。每次实时取 rect，滚动后不能缓存。 */
  const calGeom = () => {
    const cal = calRef.current
    if (!cal) return null
    const lab = cal.querySelector('.cal-lab') as HTMLElement | null
    const head = cal.querySelector('.cal-h') as HTMLElement | null
    return {
      left: cal.getBoundingClientRect().left,
      labW: lab?.offsetWidth || LAB_W,
      cellW: head?.getBoundingClientRect().width || CELL,
    }
  }

  const onBlockPointerDown = (e: React.PointerEvent, block: CalBlock, room: BoardRoom) => {
    if (e.button !== 0) return
    // 已离店灰块（含截断存根）禁止拖动：日历即真实占房视图，改「原订区间」无意义
    if (block.status === 'checked_out') {
      e.stopPropagation()
      return
    }
    // 预订/表单抽屉打开时方块不可拖（点击交给 onClick 提示或切换详情）
    if (booking !== null || formDrawerOpen()) {
      e.stopPropagation()
      return
    }
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
        ghost.style.cssText += `position:fixed;z-index:99;pointer-events:none;margin:0;width:${el.offsetWidth}px;height:${rect.height}px;box-shadow:var(--shadow-drag);opacity:.92;`
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

      const g = calGeom()
      if (!g) return
      let col = Math.floor((ev.clientX - g.left - g.labW) / g.cellW)
      col = Math.max(0, Math.min(DAYS - block.nights, col))
      const tRow = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.cal-room') as HTMLElement | null

      // 目标行按 data-room-id 数值匹配（不能用 .cal-lab 的 textContent：脏房标签带「设净」按钮，
      // textContent = 房号+设净，永远匹配不上 → 脏房拖放静默失败的 bug）
      const hitId = tRow?.dataset.roomId
      let targetRoom: BoardRoom | null = null
      if (hitId) {
        for (const g of board.data?.groups ?? []) {
          const hit = g.rooms.find(r => r.id === Number(hitId))
          if (hit) { targetRoom = hit; break }
        }
      }
      if (!targetRoom) { toast('未识别到目标房间'); return }
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
    // 退房角标：点击展开/收起明细卡（角标自身 onClick 已 stopPropagation，此处兜底）
    if ((e.target as HTMLElement).closest('.cal-dep')) return
    if ((e.target as HTMLElement).closest('.cal-block')) {
      // 预订抽屉开着：点方块提示先完成开单；表单抽屉开着：忽略，防误触
      if (booking !== null) toast('正在开单，请先提交或关闭右侧预订抽屉')
      return
    }
    // 房号标签区只显示房号 / 设净，不触发开单（曾因冒泡被夹到最左列误开单）
    if ((e.target as HTMLElement).closest('.cal-lab')) return
    if (room.status === 'maintenance' || room.notes.includes('维修')) {
      toast(`${room.number} 维修中，暂不可预订`)
      return
    }
    if (!calRef.current) return
    const date = board.data?.day_list[colAt(e.clientX)]?.date
    if (!date) return
    if (formDrawerOpen()) return
    setVacantRoom(null)
    setDetailRes(null)
    addBookingLine(toRoom(room), date, 1)
  }

  /** 指针 X 坐标 → 日历列号（0..13）。按实测几何换算（见 calGeom），滚动中每次重取。 */
  const colAt = (clientX: number) => {
    const g = calGeom()
    if (!g) return 0
    const col = Math.floor((clientX - g.left - g.labW) / g.cellW)
    return Math.max(0, Math.min(DAYS - 1, col))
  }

  /* ---------- 按住空白格横向拖选多天 → 松手按选中天数开单 ---------- */
  const onCalPointerDown = (e: React.PointerEvent, room: BoardRoom) => {
    // 只支持鼠标（触屏/触控板保持单击开单，避免与滚动打架）
    if (e.button !== 0 || e.pointerType !== 'mouse') return
    const target = e.target as HTMLElement
    if (target.closest('.cal-block') || target.closest('.cal-dep') || target.closest('.cal-lab') || target.closest('.cal-setclean') || target.closest('.cal-setdirty')) return
    // 表单抽屉打开时不启动拖选（防误触）；预订抽屉打开时允许——拖选 = 追加一行
    if (formDrawerOpen()) return
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
      addBookingLine(toRoom(room), date, nights)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  /* ---------- 多房预订行管理 ---------- */
  /** 追加一行预订（房 + 入住日 + 天数）；已开预订抽屉则累积，同房重叠时段拒绝 */
  const addBookingLine = (lineRoom: Room, checkIn: string, nights: number) => {
    if (booking) {
      // 同一房间且日期区间重叠 → 拒绝（半开区间：checkIn < existOut && existIn < checkOut）
      const newOut = addDaysIso(checkIn, nights)
      const dup = booking.lines.some(l => {
        if (l.room.id !== lineRoom.id) return false
        const lOut = addDaysIso(l.checkIn, l.nights)
        return checkIn < lOut && l.checkIn < newOut
      })
      if (dup) {
        toast(`${lineRoom.room_number} 在 ${md(checkIn)} 起的时段已在本单里，请换房间或调整日期`)
        return
      }
      setBooking({ lines: [...booking.lines, { room: lineRoom, checkIn, nights, totalText: String(nights * lineRoom.base_price), unitRef: null }] })
    } else {
      setBooking({ lines: [{ room: lineRoom, checkIn, nights, totalText: String(nights * lineRoom.base_price), unitRef: null }] })
    }
  }

  /* ---------- 已加入订单的日历高亮 ---------- */
  /** 预订抽屉未提交的行 → 该房在当前 14 天窗口内的高亮区间（列号+跨度；窗外部分裁剪，完全窗外不渲染） */
  const bookingHighlights = (roomId: number): { idx: number; col: number; span: number }[] => {
    const days = board.data?.day_list
    if (!booking || !days?.length) return []
    const wEnd = addDaysIso(days[0].date, DAYS)   // 半开区间：wEnd 当天已在窗外
    return booking.lines.flatMap((l, idx) => {
      if (l.room.id !== roomId) return []
      const out = addDaysIso(l.checkIn, l.nights)
      if (out <= days[0].date || l.checkIn >= wEnd) return []
      // 起点：入住日在窗口内取其列号；更早（「前一天」移走窗口）则从第 0 列起
      const col = days.findIndex(d => d.date === l.checkIn)
      const startCol = col >= 0 ? col : 0
      // 终点列（不含）：离店日与窗口末取小者
      const endCol = out >= wEnd ? DAYS : days.findIndex(d => d.date === out)
      const span = endCol - startCol
      return span > 0 ? [{ idx, col: startCol, span }] : []
    })
  }

  /* ---------- 直接预订（多房：逐行 POST，任一行失败即中止，已成功的不回滚） ---------- */
  const bookMut = useMutation({
    mutationFn: async (p: {
      guest_name: string; guest_phone: string; channel_id: number | null; notes: string
      /** 每行独立提交体：房号/日期/单价/天数已在 BookDrawer 内折算 */
      lines: { room_id: number; check_in: string; check_out: string; rate: number; nights: number; stay_type: 'normal' | 'hourly'; hours: number }[]
    }) => {
      const created: Reservation[] = []
      for (let i = 0; i < p.lines.length; i++) {
        const l = p.lines[i]
        try {
          const r = await api.post<Reservation>('/api/reservations', {
            guest_name: p.guest_name, guest_phone: p.guest_phone,
            room_id: l.room_id, check_in: l.check_in, check_out: l.check_out,
            channel_id: p.channel_id, notes: p.notes,
            stay_type: l.stay_type, hours: l.hours, rate: l.rate,
          })
          created.push(r)
        } catch (e: any) {
          const roomNo = booking?.lines[i]?.room.room_number ?? `第 ${i + 1} 间`
          throw Object.assign(e ?? new Error('创建失败'), { friendly: `第 ${i + 1} 间（${roomNo}）失败：${e?.message ?? '创建失败'}；前面 ${created.length} 间已创建成功` })
        }
      }
      return created
    },
    onSuccess: (rs) => {
      toast(`已创建 ${rs.length} 间预订：${rs.map(r => `${r.room_number}(${md(r.check_in)}–${md(r.check_out)})`).join('、')}`)
      setBooking(null)
      invalidate()
    },
    onError: (e: any) => toast(e.friendly ?? e.message ?? '创建失败'),
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

  /* ---------- 统一编辑（登记信息 + 实收总额，一次提交两个接口） ---------- */
  const editMut = useMutation({
    mutationFn: async (p: { id: number; reg: RegistrationBody; paid: PaidTotalBody }) => {
      await api.patch<Reservation>(`/api/reservations/${p.id}/registration`, p.reg)
      await api.patch<Reservation>(`/api/reservations/${p.id}/paid-total`, p.paid)
    },
    onSuccess: () => {
      toast('登记信息与实收已更新，操作已留痕')
      setEditRes(null)
      setDetailRes(null)
      qc.invalidateQueries({ queryKey: ['reservation'] })
      qc.invalidateQueries({ queryKey: ['folio'] })
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

  /* ---------- 更正实收（仅已退房：在住的实收已并入「编辑」抽屉） ---------- */
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

  /* ---------- 收款 / 删除收款（订单详情折叠区；详情保持打开，金额三栏实时刷新） ---------- */
  const addPayMut = useMutation({
    mutationFn: (p: { id: number; method: string; amount: number; remark: string }) =>
      api.post(`/api/reservations/${p.id}/payments`, { method: p.method, amount: p.amount, remark: p.remark }),
    onSuccess: () => {
      toast('收款成功，已计入订单账目')
      setPayAdd(false)
      invalidate()
      qc.invalidateQueries({ queryKey: ['reservation-logs'] }) // 日志 tab 立即可见新留痕
    },
    onError: (e: any) => toast(e.message ?? '收款失败'),
  })
  const delPayMut = useMutation({
    mutationFn: (p: { rid: number; pid: number }) =>
      api.delete(`/api/reservations/${p.rid}/payments/${p.pid}`),
    onSuccess: () => {
      toast('已删除该笔收款，余额已重算')
      setDelPay(null)
      invalidate()
      qc.invalidateQueries({ queryKey: ['reservation-logs'] })
    },
    onError: (e: any) => toast(e.message ?? '删除失败'),
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

  /* ---------- 预订操作日志（订单详情第二个 tab，懒加载） ---------- */
  const logsQuery = useQuery({
    queryKey: ['reservation-logs', detailRes?.id],
    enabled: detailRes !== null && orderTab === 'logs',
    queryFn: () => api.get<OpLog[]>(`/api/reservations/${detailRes!.id}/logs`),
  })

  // 打开详情抽屉时重置 tab 与折叠区（每次都从「订单详情」页进入）
  useEffect(() => {
    if (detailRes !== null) {
      setOrderTab('detail')
      setPayFoldOpen(true)
      setOtherFoldOpen(false)
    }
  }, [detailRes])

  /* ---------- 订单详情派生数据（金额三栏 / 房卡 / 折叠账目） ---------- */
  const detailR = resQuery.data ?? null
  const detailFolioData = detailFolio.data ?? null
  const orderRoomCharge = detailFolioData
    ? detailFolioData.items.filter(x => x.category === 'room_charge').reduce((s, x) => s + x.amount, 0)
    : 0
  const orderOtherItems = detailFolioData
    ? detailFolioData.items.filter(x => x.category !== 'room_charge')
    : []
  const orderOtherTotal = orderOtherItems.reduce((s, x) => s + x.amount, 0)

  /* ---------- 渲染 ---------- */
  if (board.isLoading || !board.data) return <Spinner />
  const bd = board.data
  const channelList = channels.data ?? []

  return (
    <>
      <PageHead
        title="房态盘"
        desc="点击空白格/拖选多天开单（可累积多间）· 拖动方块换房/改期"
      />

      <div className="filter-bar">
        <Segmented
          value={view}
          options={[{ key: 'cal', label: '日历' }, { key: 'grid', label: '单日网格' }]}
          onChange={setView}
        />
        <div className="cal-src-legend">
          {channelList.map(c => <span key={c.id}><i style={{ background: c.color }} />{c.name}</span>)}
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
              {g.rooms.map(room => {
                const layout = layoutRoomBlocks(room.blocks)
                return (
                <div
                  key={room.id}
                  data-room-id={room.id}
                  className={`cal-row cal-room${dragOverRoom === room.id ? ' drag-over' : ''}`}
                  onPointerDown={(e) => onCalPointerDown(e, room)}
                  onClick={(e) => onCalClick(e, room)}
                >
                  <div className={`cal-lab${room.status === 'vacant_dirty' ? ' dirty' : room.status === 'maintenance' ? ' maint' : ''}`}>
                    {room.number}
                    {/* 脏/维修房 → 「设净」；净房 → 「设脏」（房号右侧/左侧小按钮，均不触发行开单） */}
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
                    {room.status === 'vacant_clean' && (
                      <button
                        className="cal-setdirty"
                        title="干净房被弄脏时标记为空脏（待清洁）"
                        onClick={(e) => {
                          e.stopPropagation()
                          statusMut.mutate({
                            room_id: room.id, status: 'vacant_dirty',
                            label: `${room.number} 已设为脏房（待清洁）`,
                          })
                        }}
                      >设脏</button>
                    )}
                  </div>
                  {/* 已加入预订抽屉（未提交）的房间+日期区间：实线蓝框高亮，随抽屉内增删行/改天数实时联动 */}
                  {bookingHighlights(room.id).map(({ idx, col, span }) => (
                    <div key={idx} className="cal-added" style={{ gridColumn: `${col + 2} / span ${span}` }} />
                  ))}
                  {room.status === 'maintenance' || room.notes.includes('维修') ? (
                    <div className="cal-maint">维修{room.notes ? ` · ${room.notes}` : ''}</div>
                  ) : (
                    <>
                      {/* 真方块（在住/未来/多晚存根）：同列重叠 ≤2 笔，上下分轨（行高恒定 52px） */}
                      {layout.lanes.map(({ b, span, lane }) => {
                        const cls = b.status === 'checked_in' ? 'stay'
                          : b.status === 'checked_out' ? 'past' : 'future'
                        const hourly = b.stay_type === 'hourly'
                        // lane 已在 layoutRoomBlocks 里映射好：0=整行无类，1/2=上下轨 lane-1/lane-2
                        const laneCls = lane > 0 ? ` lane-${lane}` : ''
                        return (
                          <div
                            key={b.id}
                            className={`cal-block ${cls}${hourly ? ' hourly' : ''}${b.truncated && b.stub_cut ? ' truncated' : ''}${laneCls}`}
                            data-res-id={b.id}
                            style={{ gridColumn: `${b.col_start + 2} / span ${span}`, ['--src' as any]: b.channel_color }}
                            title={b.truncated ? `${b.guest_name} · 已离店（${b.check_in.slice(5).replace('-', '/')} 入住，原订至 ${b.check_out.slice(5).replace('-', '/')}，实际已提前退房）` : undefined}
                            onPointerDown={(e) => onBlockPointerDown(e, b, room)}
                            onClick={() => {
                              if (justDraggedRef.current) return
                              // 预订抽屉开着：点方块提示先完成开单；表单抽屉开着：忽略，防止详情被偷偷切走
                              if (booking !== null) { toast('正在开单，请先提交或关闭右侧预订抽屉'); return }
                              if (formDrawerOpen()) return
                              setDetailRes({ id: b.id } as Reservation)
                            }}
                          >
                            <span className="g">{b.guest_name}{hourly ? ' · 钟点' : ''}</span>
                            <span className="s">{hourly ? `${b.hours ?? 0} 小时` : b.channel_name}</span>
                            {(b.status === 'checked_in' || b.status === 'checked_out') && b.balance_due > 0 && <span className="owe">欠</span>}
                            {/* 超付（实付>应收，不限状态）——「欠」的互斥对位：超付时后端已把 balance_due 钳 0，欠徽章不会同显 */}
                            {b.paid_total > b.items_total && (
                              <span className="over" title={`实付 ¥${b.paid_total} · 超收 ¥${b.paid_total - b.items_total}`}>超</span>
                            )}
                          </div>
                        )
                      })}
                      {/* 当日入住当日退（钟点房/当日往返，不限笔数）：聚合为格角「退房」角标，悬停/点按看明细并可编辑 */}
                      {layout.deps.map(({ col, list }) => (
                        <button
                          key={`dep-${col}`} type="button" className="cal-dep"
                          style={{ gridColumn: `${col + 2} / span 1` }}
                          aria-label={`${md(bd.day_list[col]?.date ?? '')} 已退 ${list.length} 笔，悬停或点击查看`}
                          onMouseEnter={(e) => openDep(room.number, col, list, e.currentTarget)}
                          onMouseLeave={hideDepSoon}
                          onClick={(e) => {
                            e.stopPropagation()
                            // 预订抽屉开着：先完成开单；表单抽屉开着：忽略（与方块点击守卫同口径）
                            if (booking !== null) { toast('正在开单，请先提交或关闭右侧预订抽屉'); return }
                            if (formDrawerOpen()) return
                            // 单笔聚合：跳过浮卡直接开订单详情（多笔才需要浮卡列表消歧）
                            if (list.length === 1) { closeDep(); setDetailRes({ id: list[0].id } as Reservation); return }
                            toggleDep(room.number, col, list, e.currentTarget)
                          }}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                            <path d="m16 17 5-5-5-5" />
                            <path d="M21 12H9" />
                          </svg>
                        </button>
                      ))}
                    </>
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
                )
              })}
            </div>
          ))}
        </div>
      </div>
          <p className="hint mt-16 cal-legend">
            图例：<Badge color="blue">在住</Badge> <Badge color="orange">未来抵店</Badge> <Badge color="red">欠</Badge> 在住/已离店未结清 · <Badge color="purple">超</Badge> 实付超过应收（多收待退）· 灰块 = 已离店（离店日格子只压左 1/3，当天下午起腾空，空白即可售，含当日钟点房）· 格子左上角<b style={{ color: 'var(--text-primary)' }}>退房图标</b> = 当日有客人退房，悬停看明细、<b>点按展开详情并可编辑</b>（更正实收 / 撤销退房）·
            方块最前端竖条颜色 = 预订来源（可在「设置 → 来源渠道」配置）。<b>拖动方块换房/改期（冲突自动回弹）· 点击空白格直接开单 · 房号旁「设净/设脏」一键切换房态</b>。
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

      {/* ---------- 直接预订抽屉（多房累积） ---------- */}
      <BookDrawer
        open={booking !== null}
        lines={booking?.lines ?? []}
        channels={channelList}
        busy={bookMut.isPending}
        onClose={() => setBooking(null)}
        onChangeLines={(lines) => setBooking({ lines })}
        onSubmit={(p) => bookMut.mutate(p)}
      />

      {/* ---------- 空房操作抽屉 ---------- */}
      <Drawer
        open={vacantRoom !== null}
        passthrough
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
                  onClick={() => {
                    const r = vacantRoom!
                    setVacantRoom(null)
                    addBookingLine(r, todayIso(), 1)
                  }}
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
      </Drawer>

      {/* ---------- 订单详情抽屉（双 tab：订单详情 / 操作日志；版式对齐 design/prototype/rooms.html） ---------- */}
      <Drawer
          open={detailRes !== null}
          passthrough
          lg
          onClose={() => setDetailRes(null)}
          footClass="order-foot"
          head={
            <div className="dialog-head order-head">
              <div className="order-tabs" role="tablist">
                <button className={orderTab === 'detail' ? 'active' : ''} onClick={() => setOrderTab('detail')}>订单详情</button>
                <button className={orderTab === 'logs' ? 'active' : ''} onClick={() => setOrderTab('logs')}>操作日志</button>
              </div>
              <button className="icon-btn" aria-label="关闭" onClick={() => setDetailRes(null)}><X size={15} /></button>
            </div>
          }
          bodyClass="order-body"
          foot={
            detailR ? (
              <>
                {/* 左：撤销 / 危险操作；右：主操作 */}
                <div className="grp">
                  {(detailR.status === 'pending' || detailR.status === 'confirmed') && (
                    <button className="btn btn-danger-ghost" onClick={() => setCancelRes(detailR)}>取消预订</button>
                  )}
                  {detailR.status === 'checked_in' && (
                    <button className="btn btn-danger-ghost" onClick={() => { setUndoRes(detailR); setDetailRes(null) }}>撤销入住</button>
                  )}
                  {detailR.status === 'checked_out' && (
                    <button className="btn btn-danger-ghost" onClick={() => { setUndoOutRes(detailR); setDetailRes(null) }}>撤销退房</button>
                  )}
                </div>
                <div className="grp">
                  {detailR.status === 'pending' && (
                    <button className="btn btn-ghost" onClick={() => resMut.mutate({ path: `${detailR.id}/confirm`, label: '预订已确认' })}>确认预订</button>
                  )}
                  {(detailR.status === 'pending' || detailR.status === 'confirmed') && (
                    <button className="btn btn-ghost" onClick={() => { setAdjustRes(detailR); setDetailRes(null) }}>调整预订</button>
                  )}
                  {(detailR.status === 'pending' || detailR.status === 'confirmed') && detailR.check_in <= todayIso() && (
                    <button className="btn btn-primary" onClick={() => setCheckinRes(detailR)}>办理入住</button>
                  )}
                  {detailR.status === 'checked_in' && (
                    <>
                      {/* 统一「编辑」抽屉：登记信息与实收同页编辑、一次保存 */}
                      <button className="btn btn-ghost" onClick={() => { setEditRes(detailR); setDetailRes(null) }}>编辑</button>
                      <button className="btn btn-ghost" onClick={() => setExtendRes(detailR)}>延住</button>
                      <button
                        className="btn btn-primary"
                        onClick={() => {
                          api.post(`/api/reservations/${detailR.id}/check-out`, { force: false, payments: [] })
                            .then(() => { toast('退房完成，房态转空脏'); setDetailRes(null); invalidate() })
                            .catch((e: any) => {
                              if (e.status === 409) {
                                // 未结清 → 应用内确认弹层（ConfirmDialog）再强制退房
                                setForceOut({ id: detailR.id, bal: e.data?.detail?.balance_due ?? 0 })
                              } else toast(e.message)
                            })
                        }}
                      >办理退房</button>
                    </>
                  )}
                  {detailR.status === 'checked_out' && (
                    <>
                      {detailR.room_id && detailR.room_status === 'vacant_dirty' && (
                        <button
                          className="btn btn-primary"
                          onClick={() => {
                            statusMut.mutate({
                              room_id: detailR.room_id!, status: 'vacant_clean',
                              label: `${detailR.room_number} 已转为净房`,
                            })
                            setDetailRes(null)
                          }}
                        >转为净房</button>
                      )}
                      <button className="btn btn-ghost" onClick={() => { setPaidRes(detailR); setDetailRes(null) }}>更正实收</button>
                    </>
                  )}
                </div>
              </>
            ) : null
          }
        >
        {detailR && orderTab === 'detail' && detailFolioData && (
          <>
            <div className="order-top">
              <span className="order-guest">
                {detailR.guest_name} {detailR.vip_level && <Badge color="purple">{detailR.vip_level}</Badge>}
              </span>
              <span className="order-badges">
                {detailR.channel_name && (
                  <span className="badge badge-gray">
                    {detailR.channel_color && <span className="dot" style={{ background: detailR.channel_color }} />}
                    {detailR.channel_name}
                  </span>
                )}
                <Badge color={RES_STATUS_BADGE[detailR.status]?.color ?? 'gray'}>{RES_STATUS_BADGE[detailR.status]?.label ?? detailR.status}</Badge>
              </span>
            </div>
            {/* 金额三栏：订单金额 / 已付金额 / 还需付款（口径 = folio 三项合计） */}
            <div className="money3">
              <div><span className="lab">订单金额</span><b className="val accent">{fmtMoney(detailFolioData.total_charge)}</b></div>
              <div><span className="lab">已付金额</span><b className="val accent">{fmtMoney(detailFolioData.total_paid)}</b></div>
              <div>
                <span className="lab">还需付款</span>
                {/* 超付（多收/更正实收后）balance_due 为负：按原型口径收口为 0，超付额看「已付金额」栏 */}
                <b className="val danger">{fmtMoney(Math.max(0, detailFolioData.balance_due))}</b>
                {(detailR.status === 'pending' || detailR.status === 'confirmed') && detailFolioData.balance_due > 0 && (
                  <span className="sub">到店结清</span>
                )}
              </div>
            </div>
            <div className="order-sec">
              <b>房间信息 <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(orderRoomCharge)}</span></b>
              <span className="side">共 1 间房 · 消耗 {detailR.stay_type === 'hourly' ? `${detailR.hours} 小时` : `${detailR.nights} 间夜`}</span>
            </div>
            <div className="room-card">
              <div className="rc-top">
                <span className="rc-name">{detailR.room_type_name}-{detailR.room_number ?? '未分配'}</span>
                <span className="rc-price">{orderRoomCharge > 0 ? fmtMoney(orderRoomCharge) : `${fmtMoney(detailR.rate)}${detailR.stay_type === 'hourly' ? '/小时' : '/晚'}`}</span>
                <Badge color={RES_STATUS_BADGE[detailR.status]?.color ?? 'gray'}>{RES_STATUS_BADGE[detailR.status]?.label ?? detailR.status}</Badge>
              </div>
              <div className="rc-sub">
                {md(detailR.check_in)} – {md(detailR.check_out)} · {detailR.stay_type === 'hourly' ? `钟点 ${detailR.hours} 小时` : `共 ${detailR.nights} 晚`}
                {' · '}{fmtMoney(detailR.rate)}{detailR.stay_type === 'hourly' ? ' / 小时' : ' / 晚'}
                {' · '}{detailR.guest_name}{detailR.guest_phone ? ` · ${maskPhone(detailR.guest_phone)}` : ''}
                {/* 提前退房：实住口径与日历灰块截断一致（actual < check_out 才算提前） */}
                {detailR.status === 'checked_out' && detailR.actual_check_out && detailR.actual_check_out < detailR.check_out &&
                  ` · 实住至 ${md(detailR.actual_check_out)}（提前退房，尾段已放出续售）`}
              </div>
            </div>

            {/* 收款金额折叠区（默认展开）：明细 + 行内删除 + ＋收款（仅在住/已退，口径对齐 paid-total） */}
            <div className={`fold${payFoldOpen ? ' open' : ''}`}>
              <div className="fold-head" onClick={() => setPayFoldOpen(v => !v)}>
                <span className="arr">▸</span>
                <b>收款金额：<span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(detailFolioData.total_paid)}</span></b>
                <span className="side">
                  {!(detailR.status === 'pending' || detailR.status === 'confirmed') && (
                    <button className="link-btn" onClick={(e) => { e.stopPropagation(); setPayAdd(true) }}>＋ 收款</button>
                  )}
                </span>
              </div>
              {payFoldOpen && (
                <div className="fold-body">
                  {detailFolioData.payments.length === 0 ? (
                    <div className="muted" style={{ padding: '4px 2px 10px', fontSize: 13 }}>
                      {(detailR.status === 'pending' || detailR.status === 'confirmed') ? '尚未收款（房费到店结清）' : '尚无收款记录'}
                    </div>
                  ) : (
                    <table className="table pay-table">
                      <thead><tr><th>项目</th><th>支付方式</th><th className="num">金额</th><th>日期</th><th>操作</th></tr></thead>
                      <tbody>
                        {detailFolioData.payments.map(p => (
                <tr key={p.id}>
                  <td>订单收款{p.remark && <div className="pay-remark">{p.remark}</div>}</td>
                  <td>{payMethodLabel(pms.data, p.method)}</td>
                  <td className="num">{fmtMoney(p.amount)}</td>
                  <td>{mdt(p.created_at)}</td>
                  <td><button className="link-del" onClick={() => setDelPay({ rid: detailR.id, pay: p })}>删除</button></td>
                </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>

            {/* 其他消费折叠区（仅有消费时出现；加收费用走账务/编辑入口） */}
            {orderOtherItems.length > 0 && (
              <div className={`fold${otherFoldOpen ? ' open' : ''}`}>
                <div className="fold-head" onClick={() => setOtherFoldOpen(v => !v)}>
                  <span className="arr">▸</span>
                  <b>其他消费：<span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(orderOtherTotal)}</span></b>
                </div>
                {otherFoldOpen && (
                  <div className="fold-body">
                    {orderOtherItems.map(x => (
                      <div key={x.id} className="consume-row">
                        <span className="d">{x.description}</span>
                        <b>{fmtMoney(x.amount)}</b>
                        <span className="t">{mdt(x.created_at)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="order-meta">
              <div className="kv"><span>订单号</span><b>{detailR.code}</b></div>
              {detailR.notes && <div className="kv"><span>备注</span><span>{detailR.notes}</span></div>}
              {(detailR.status === 'pending' || detailR.status === 'confirmed') && detailR.check_in > todayIso() && (
                <div className="kv"><span>到店提示</span><span className="warn">未来抵店 · 当前仅可预订，{md(detailR.check_in)} 当天方可办理入住</span></div>
              )}
              {detailR.status === 'checked_out' && (
                <div className="kv"><span>房态</span><span>{ROOM_STATUS_LABEL[detailR.room_status ?? ''] ?? '—'}</span></div>
              )}
              <div className="kv"><span>操作人</span><span>{detailR.operator_name ?? '—'}</span></div>
            </div>
          </>
        )}
        {detailR && orderTab === 'detail' && !detailFolioData && (
          <div className="muted" style={{ padding: '24px 0' }}>账目加载中…</div>
        )}
        {detailR && orderTab === 'logs' && (
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
      </Drawer>

      {/* ---------- 收款小弹层（订单详情折叠区「＋收款」；确认后详情保持打开并刷新三栏） ---------- */}
      {payAdd && detailR && (
        <AddPaymentDialog
          onClose={() => setPayAdd(false)}
          onSubmit={(p) => addPayMut.mutate({ id: detailR.id, method: p.method, amount: p.amount, remark: p.remark })}
          busy={addPayMut.isPending}
        />
      )}

      {/* ---------- 删除收款确认（应用内弹层替代 window.confirm；确认后详情保持打开） ---------- */}
      {delPay && detailR && (
        <ConfirmDialog open onClose={() => setDelPay(null)} busy={delPayMut.isPending}
          title="删除收款" sub={`${detailR.guest_name} · ${detailR.code}`} confirmText="删除"
          onConfirm={() => delPayMut.mutate({ rid: delPay.rid, pid: delPay.pay.id })}>
          <p className="confirm-msg">确定删除这笔收款吗？</p>
          <div className="info-row"><span>款项</span><span>{payMethodLabel(pms.data, delPay.pay.method)} {fmtMoney(delPay.pay.amount)}</span></div>
          <div className="info-row"><span>收款时间</span><span>{mdt(delPay.pay.created_at)}</span></div>
          {delPay.pay.remark && <div className="info-row"><span>备注</span><span>{delPay.pay.remark}</span></div>}
          <div className="danger-note">
            删除后账单余额将增加 <b>{fmtMoney(delPay.pay.amount)}</b>，且不生成退款凭证（操作全程写入预订日志）。
          </div>
        </ConfirmDialog>
      )}

      {/* ---------- 取消预订确认（待确认/已确认：取消会清除已收款） ---------- */}
      {cancelRes && (
        <ConfirmDialog open onClose={() => setCancelRes(null)} busy={resMut.isPending}
          title="取消预订" sub={`${cancelRes.guest_name} · ${cancelRes.code}`} confirmText="确认取消"
          onConfirm={() => { setCancelRes(null); resMut.mutate({ path: `${cancelRes.id}/cancel`, label: '预订已取消' }) }}>
          <p className="confirm-msg">确定取消该预订吗？</p>
          <div className="danger-note">取消会清除该预订已收取的款项（不生成退款凭证），且不可恢复。</div>
        </ConfirmDialog>
      )}

      {/* ---------- 强制退房确认（退房 409 未结清时；走原 force 请求） ---------- */}
      {forceOut && (
        <ConfirmDialog open onClose={() => setForceOut(null)}
          title="强制退房" confirmText="强制退房"
          onConfirm={() => {
            setForceOut(null)
            api.post(`/api/reservations/${forceOut.id}/check-out`, { force: true })
              .then(() => { toast('已强制退房（未结清转挂账）'); setDetailRes(null); invalidate() })
          }}>
          <p className="confirm-msg">存在未结清账款 {fmtMoney(forceOut.bal)}，确定强制退房吗？</p>
          <div className="danger-note">强制退房后未结清金额转挂账（订单保持欠款状态），可稍后补收；退房后房态转空脏。</div>
        </ConfirmDialog>
      )}

      {/* ---------- 入住向导（预订详情内办理入住） ---------- */}
      {checkinRes && (
        <CheckInDialog
          res={checkinRes} busy={checkinMut.isPending} drawer
          onClose={() => setCheckinRes(null)}
          onConfirm={(body, label) => checkinMut.mutate({ body, label })}
        />
      )}

      {/* ---------- 延住抽屉（预订详情内） ---------- */}
      {extendRes && (
        <ExtendDialog
          res={extendRes} busy={extendMut.isPending} drawer
          onClose={() => setExtendRes(null)}
          onConfirm={(body) => extendMut.mutate({ id: extendRes.id, body })}
        />
      )}

      {/* ---------- 统一编辑抽屉（在住：登记 + 实收同页） ---------- */}
      {editRes && (
        <EditDrawer
          res={editRes} channels={channelList}
          busy={editMut.isPending}
          onClose={() => { setEditRes(null); setDetailRes(editRes) }}
          onConfirm={(reg, paid) => editMut.mutate({ id: editRes.id, reg, paid })}
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

      {/* ---------- 更正实收（仅已退房；在住的实收已并入「编辑」抽屉） ---------- */}
      {paidRes && (
        <EditPaidDialog
          res={paidRes} folio={paidFolio.data} busy={paidMut.isPending}
          onClose={() => { setPaidRes(null); setDetailRes(paidRes) }}
          onConfirm={(body) => paidMut.mutate({ id: paidRes.id, body })}
        />
      )}

      {/* ---------- 退房角标明细卡（同日多笔已退聚合；点角标钉住，点行直接开订单详情抽屉） ---------- */}
      {dep && createPortal(
        <div className="dep-pop" ref={depRef} role="dialog" aria-label={`${dep.roomNo} ${dep.day} 退房明细`}
          onMouseEnter={cancelDepHide} onMouseLeave={hideDepSoon}>
          <div className="t">{dep.roomNo} · {dep.day} 已退 {dep.deps.length} 笔</div>
          <div className="agg-list">
            {dep.deps.map(d => (
              <div key={d.id} className="agg-item">
                <button type="button" className="agg-row"
                  onClick={() => { closeDep(); setDetailRes({ id: d.id } as Reservation) }}>
                  <span className="g">{d.guest_name}</span>
                  <span className="m">{d.stay_type === 'hourly' ? `钟点 ${d.hours ?? 0} 小时 · ${d.channel_name}` : `当日往返 · ${d.channel_name}`}</span>
                  <span className="badge badge-gray">已离店</span>
                  <b>¥{d.items_total}</b>
                  <span className="agg-caret"><ChevronRight size={14} strokeWidth={2.2} /></span>
                </button>
              </div>
            ))}
          </div>
        </div>,
        document.body,
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

/* ---------- 收款小弹层（订单详情「＋收款」）：金额 + 收款方式 + 选填备注，方式来自设置配置 ---------- */
function AddPaymentDialog({ onClose, onSubmit, busy }: {
  onClose: () => void
  onSubmit: (p: { method: string; amount: number; remark: string }) => void
  busy: boolean
}) {
  const pms = usePayMethods()
  const [method, setMethod] = useState('')
  const [amount, setAmount] = useState('')
  const [remark, setRemark] = useState('')
  // 默认值必须同步进 state（来源默认值坑规则）：不能只靠 select 的渲染兜底
  useEffect(() => {
    const codes = pms.data?.map(m => m.code) ?? []
    if (codes.length && !codes.includes(method)) setMethod(codes[0])
  }, [pms.data, method])
  const n = Number(amount)
  return (
    <Dialog
      open
      onClose={onClose}
      title="收款"
      sub="向当前订单补收款项 · 收款后余额 = 应收 − 已收总额"
      foot={
        <>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary"
            disabled={busy || !n || n <= 0 || !method}
            onClick={() => onSubmit({ method, amount: n, remark: remark.trim() })}
          >确认收款</button>
        </>
      }
    >
      <Field label="收款金额（元）" required hint="在住/已退订单可随时补收；取消预订才会清除已收款。">
        <input
          className="input" inputMode="numeric" autoFocus
          placeholder="如：572"
          value={amount}
          onChange={e => setAmount(e.target.value.replace(/[^\d]/g, ''))}
        />
      </Field>
      <Field label="收款方式" hint="选项与顺序来自「设置 → 收款方式」配置。">
        <select className="select" value={method} onChange={e => setMethod(e.target.value)}>
          {(pms.data ?? []).map(m => <option key={m.code} value={m.code}>{m.name}</option>)}
        </select>
      </Field>
      <Field label="备注" hint="选填 · 展示在收款明细与操作日志，最多 120 字。">
        <input
          className="input" maxLength={120}
          placeholder="如：代收押金、楼层调整差价"
          value={remark}
          onChange={e => setRemark(e.target.value)}
        />
      </Field>
    </Dialog>
  )
}

/* ---------- 统一编辑抽屉（在住：登记信息 + 实收总额同页，一次保存） ---------- */
function EditDrawer({ res, channels, busy, onClose, onConfirm }: {
  res: Reservation
  channels: Channel[]
  busy: boolean
  onClose: () => void
  onConfirm: (reg: RegistrationBody, paid: PaidTotalBody) => void
}) {
  /* 实收数据自带查询：详情抽屉已关闭时 detailFolio 不再可用，这里按编辑目标 id 单独取 */
  const folioQuery = useQuery({
    queryKey: ['folio', res.id],
    queryFn: () => api.get<Folio>(`/api/reservations/${res.id}/folio`),
  })
  const folio = folioQuery.data
  /* ---- 登记信息 ---- */
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

  /* ---- 实收信息 ---- */
  const curPaid = folio?.total_paid ?? 0
  const [paidText, setPaidText] = useState<string | null>(null)
  // 补收方式来自设置（各店可配置）；默认值同步进 state，不能只靠 select 渲染兜底
  const pms = usePayMethods()
  const [method, setMethod] = useState('')
  useEffect(() => {
    const codes = pms.data?.map(m => m.code) ?? []
    if (codes.length && !codes.includes(method)) setMethod(codes[0])
  }, [pms.data, method])
  const paidValue = paidText ?? (folio ? String(curPaid) : '')
  const paidAmount = Math.max(0, Math.round(Number(paidValue) || 0))
  const paidDiff = paidAmount - curPaid

  return (
    <Drawer
      open passthrough onClose={onClose}
      title="编辑"
      sub={`${res.room_number ?? '未分配'} · ${res.guest_name} · ${res.code} · 登记与实收同页编辑`}
      foot={
        <>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary" disabled={busy || !name.trim() || !folio}
            onClick={() => onConfirm({
              guest_name: name, guest_phone: phone,
              ...(hourly ? {} : { nights }),
              rate: unitPrice, channel_id: channelId, notes,
            }, { amount: paidAmount, method })}
          >保存修改</button>
        </>
      }
    >
      <div className="section-sub" style={{ margin: '0 0 10px' }}>登记信息</div>
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

      <div className="section-sub" style={{ margin: '18px 0 10px', paddingTop: 16, borderTop: '1px solid var(--hairline-soft)' }}>实收信息</div>
      <div className="info-row"><span>应收（房费 + 杂费）</span><span>{folio ? fmtMoney(folio.total_charge) : '读取中…'}</span></div>
      <div className="info-row"><span>当前已收</span><span>{folio ? fmtMoney(curPaid) : '读取中…'}</span></div>
      <Field
        label="已收总额（整单，元）"
        hint={folio
          ? `较当前 ${paidDiff >= 0 ? '+' : '−'}${fmtMoney(Math.abs(paidDiff))} · 保存后余额 = 应收 − 已收总额。`
          : '读取中…'}
      >
        <input
          className="input" inputMode="numeric" value={paidValue}
          onChange={e => setPaidText(e.target.value.replace(/[^\d]/g, ''))}
        />
      </Field>
      <Field label="补收方式（增加时使用）">
        <select className="select" value={method} onChange={e => setMethod(e.target.value)}>
          {(pms.data ?? []).map(m => <option key={m.code} value={m.code}>{m.name}</option>)}
        </select>
      </Field>
      <p className="hint warn">减少已收会冲减收款记录（从最新一笔起），不生成退款凭证；保存后登记与实收均写入预订日志。</p>
    </Drawer>
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
    <Drawer
      open passthrough onClose={onClose}
      title="撤销入住"
      sub={`${res.room_number ?? '未分配'} · ${res.guest_name} · ${res.code}`}
      foot={
        <>
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
    </Drawer>
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
    <Drawer
      open passthrough onClose={onClose}
      title="撤销退房"
      sub={`${res.room_number ?? '未分配'} · ${res.guest_name} · ${res.code}`}
      foot={
        <>
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
    </Drawer>
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
  // 补收方式来自设置（各店可配置）；默认值同步进 state，不能只靠 select 渲染兜底
  const pms = usePayMethods()
  const [method, setMethod] = useState('')
  useEffect(() => {
    const codes = pms.data?.map(m => m.code) ?? []
    if (codes.length && !codes.includes(method)) setMethod(codes[0])
  }, [pms.data, method])
  // 数据异步到达后用当前已收填充一次
  const value = amountText ?? (folio ? String(cur) : '')
  const amount = Math.max(0, Math.round(Number(value) || 0))
  const diff = amount - cur

  return (
    <Drawer
      open passthrough onClose={onClose}
      title="更正实收"
      sub={`${res.room_number ?? '未分配'} · ${res.guest_name} · ${res.code}`}
      foot={
        <>
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
        <select className="select" value={method} onChange={e => setMethod(e.target.value)}>
          {(pms.data ?? []).map(m => <option key={m.code} value={m.code}>{m.name}</option>)}
        </select>
      </Field>
      <p className="hint warn">减少已收会冲减收款记录（从最新一笔起），不生成退款凭证；全过程写入预订日志。</p>
    </Drawer>
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
    <Drawer
      open passthrough onClose={onClose}
      title="调整预订"
      sub={`${res.room_number ?? res.room_type_name} · ${res.guest_name} · ${res.code}`}
      foot={
        <>
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
    </Drawer>
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

/* ---------- 直接预订抽屉（多房累积：每行一间房，公共客人信息，逐行提交） ---------- */
function BookDrawer({ open, lines, channels, busy, onClose, onChangeLines, onSubmit }: {
  open: boolean
  lines: BookingLine[]
  channels: Channel[]
  busy: boolean
  onClose: () => void
  onChangeLines: (lines: BookingLine[]) => void
  onSubmit: (p: {
    guest_name: string; guest_phone: string; channel_id: number | null; notes: string
    lines: { room_id: number; check_in: string; check_out: string; rate: number; nights: number; stay_type: 'normal' | 'hourly'; hours: number }[]
  }) => void
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [channelId, setChannelId] = useState<number | null>(null)
  /** 钟点仅在恰好 1 行时可用：多房按整晚处理，避免多房×钟点的组合复杂度 */
  const [stayType, setStayType] = useState<'normal' | 'hourly'>('normal')
  const [hours, setHours] = useState(4)

  useEffect(() => {
    if (open) { setName(''); setPhone(''); setChannelId(null); setStayType('normal'); setHours(4) }
  }, [open])

  // 来源没有「未指定」选项：下拉框必显示第一项（设置里的第一个渠道，通常为美团），
  // 状态必须同步选中它，否则会出现「显示美团、提交 null、方块竖条落成灰色默认值」的错位
  useEffect(() => {
    if (!open) return
    setChannelId(prev => (prev === null ? (channels[0]?.id ?? null) : prev))
  }, [open, channels])

  // 钟点可用性必须在 early return 之前算好：下面这个 effect 的依赖数组会在此处求值
  const single = lines.length === 1
  const hourlyAvail = single && (lines[0].room.hourly_price ?? 0) > 0

  // 点「钟点」后又在日历追加第二间房：钟点仅单行可用，自动退回整晚并按基准价恢复该行总额
  // （点钟点时总额已被覆盖为 hours × 钟点价，多行模式下会按错误单价折算整晚费用）
  useEffect(() => {
    if (!hourlyAvail && stayType === 'hourly' && lines.length > 0) {
      setStayType('normal')
      onChangeLines(lines.map((l, i) => (i === 0 ? { ...l, totalText: String(l.nights * l.room.base_price), unitRef: null } : l)))
    }
  }, [hourlyAvail, stayType])

  if (!open || lines.length === 0) return null

  const firstRoom = lines[0].room
  const isHourly = single && stayType === 'hourly'
  const grandTotal = lines.reduce((s, l) => {
    const n = Math.max(1, Math.round(Number(l.totalText) || 0))
    return s + n
  }, 0)
  const linesInvalid = lines.some(l => l.nights <= 0 || (Math.round(Number(l.totalText) || 0) <= 0))

  /** 行内改天数：按行当前折合单价（手改过则用 unitRef，否则系统基准价）重算总额 */
  const lineNightsChange = (idx: number, v: string) => {
    const next = lines.map((l, i) => {
      if (i !== idx) return l
      const n = Math.max(1, Math.round(Number(v.replace(/[^\d]/g, '')) || 1))
      const curTotal = Math.max(0, Math.round(Number(l.totalText) || 0))
      const unit = l.unitRef ?? ((l.nights > 0 ? Math.round(curTotal / l.nights) : 0) || l.room.base_price)
      return { ...l, nights: n, totalText: String(n * unit) }
    })
    onChangeLines(next)
  }
  /** 行内手改总额：折算单价记入 unitRef */
  const lineTotalChange = (idx: number, v: string) => {
    const digits = v.replace(/[^\d]/g, '')
    const next = lines.map((l, i) => {
      if (i !== idx) return l
      const t = Math.max(0, Math.round(Number(digits) || 0))
      const unit = l.nights > 0 ? Math.round(t / l.nights) : 0
      return { ...l, totalText: digits, unitRef: unit }
    })
    onChangeLines(next)
  }
  const removeLine = (idx: number) => onChangeLines(lines.filter((_, i) => i !== idx))

  const submit = () => {
    onSubmit({
      guest_name: name, guest_phone: phone, channel_id: channelId, notes: '',
      lines: lines.map(l => {
        const t = Math.max(0, Math.round(Number(l.totalText) || 0))
        const n = Math.max(1, l.nights)
        const rate = Math.round(t / n)
        if (isHourly) {
          // 钟点：仅第一行（单行模式），check_out 占整日 = check_in + 1 天，后端口径一致
          return { room_id: l.room.id, check_in: l.checkIn, check_out: addDaysIso(l.checkIn, 1), rate, nights: 1, stay_type: 'hourly' as const, hours }
        }
        return { room_id: l.room.id, check_in: l.checkIn, check_out: addDaysIso(l.checkIn, n), rate, nights: n, stay_type: 'normal' as const, hours: 0 }
      }),
    })
  }

  return (
    <Drawer
      open={open} passthrough onClose={onClose}
      title={`直接预订 · ${lines.length} 间`}
      sub="点击/拖选日历空白格追加房间；同一单共用客人与来源"
      foot={
        <>
          <span className="hint" style={{ marginRight: 'auto' }}>共 {lines.length} 间 · 合计 ¥{grandTotal.toLocaleString()}</span>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary" disabled={busy || !name.trim() || linesInvalid || lines.length === 0}
            onClick={submit}
          >确认预订{lines.length > 1 ? `（${lines.length} 间）` : ''}</button>
        </>
      }
    >
      <div className="form-row">
        <Field label="客人姓名" required>
          <GuestNameInput value={name} onChange={setName} onPick={g => { setName(g.name); setPhone(g.phone || '') }} />
        </Field>
        <Field label="手机号（选填）" hint="填写后用于接收确认短信；未填写则到店补录。">
          <input className="input" value={phone} onChange={e => setPhone(e.target.value)} placeholder="可留空，到店时补录" />
        </Field>
      </div>
      {hourlyAvail && (
        <Field label="入住方式">
          <div className="segmented">
            <button className={!isHourly ? 'active' : ''} onClick={() => { setStayType('normal'); onChangeLines([{ ...lines[0], totalText: String(lines[0].nights * firstRoom.base_price), unitRef: null }]) }}>整晚</button>
            <button className={isHourly ? 'active' : ''} onClick={() => { setStayType('hourly'); onChangeLines([{ ...lines[0], totalText: String(hours * (firstRoom.hourly_price || 0)) }]) }}>钟点</button>
          </div>
          <span className="hint">钟点价 ¥{firstRoom.hourly_price}/小时（设置 → 房型 中配置）；钟点房占用当日整天，创建后不可拖动改期。多间房仅支持整晚。</span>
        </Field>
      )}
      {isHourly && (
        <Field label="入住时长">
          <div className="chips">
            {[2, 3, 4, 6, 8].map(x => (
              <button
                key={x} className={`chip${hours === x ? ' active' : ''}`}
                onClick={() => { setHours(x); onChangeLines([{ ...lines[0], totalText: String(x * (firstRoom.hourly_price || 0)) }]) }}
              >{x} 小时</button>
            ))}
          </div>
        </Field>
      )}

      <div className="section-sub" style={{ margin: '6px 0 8px' }}>
        房间（{lines.length} 间）· 在日历上继续点击或拖选可追加
      </div>
      <div className="book-lines">
        {lines.map((l, i) => {
          const t = Math.max(0, Math.round(Number(l.totalText) || 0))
          const n = Math.max(1, l.nights)
          const unit = Math.round(t / n)
          return (
            <div key={`${l.room.id}-${l.checkIn}-${i}`} className="book-line">
              <div className="bl-room">
                <div className="no">{l.room.room_number} · {l.room.room_type_name || '客房'}</div>
                <div className="meta">
                  {md(l.checkIn)} 入住 · {!isHourly && (
                    <>
                      天数
                      <input
                        className="bl-input" inputMode="numeric" value={String(l.nights)}
                        onChange={e => lineNightsChange(i, e.target.value)}
                        aria-label="入住天数"
                      /> 晚（{md(addDaysIso(l.checkIn, n))} 离店）
                    </>
                  )}
                  {isHourly && `钟点 ${hours} 小时`}
                </div>
              </div>
              <input
                className="bl-input amt" inputMode="numeric" value={l.totalText}
                onChange={e => lineTotalChange(i, e.target.value)}
                aria-label="行整单总额"
                title="行整单总额（元）"
              />
              <span className="bl-amt" style={{ color: 'var(--text-secondary)', fontWeight: 400, fontSize: 12 }}>折合 ¥{unit}/{isHourly ? '小时' : '晚'}</span>
              <button className="icon-btn" aria-label="移除该房间" onClick={() => removeLine(i)}><X size={14} /></button>
            </div>
          )
        })}
      </div>
      <p className="hint" style={{ marginTop: 10 }}>
        逐间提交，任一间失败（如时段冲突）即中止，已成功的保留；金额填每间整单总额，按天数折合单价入账。来源选项与顺序来自「设置 → 来源渠道」。
      </p>
      <Field label="来源">
        <select className="select" value={channelId ?? ''} onChange={e => setChannelId(e.target.value ? Number(e.target.value) : null)}>
          {channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
    </Drawer>
  )
}
