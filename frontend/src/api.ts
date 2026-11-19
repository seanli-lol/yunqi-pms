/* API 客户端：JWT + 酒店上下文注入 */
export interface LoginUser {
  id: number
  name: string
  username: string
  role: 'platform_admin' | 'admin' | 'receptionist' | 'housekeeper'
  role_label: string
  hotel_id: number | null
  hotel_name: string | null
}

let token: string | null = localStorage.getItem('pms_token')
let hotelResolver: () => number | null = () => null

export function setAuthToken(t: string | null) {
  token = t
  if (t) localStorage.setItem('pms_token', t)
  else localStorage.removeItem('pms_token')
}

export function getAuthToken() {
  return token
}

/** 平台管理员登录后注册当前操作酒店（业务接口自动带 hotel_id） */
export function setHotelResolver(fn: () => number | null) {
  hotelResolver = fn
}

export class ApiError extends Error {
  status: number
  data: any
  constructor(status: number, data: any) {
    super(typeof data === 'string' ? data : (data?.detail?.message ?? data?.detail ?? '请求失败'))
    this.status = status
    this.data = data
  }
}

async function request<T = any>(method: string, path: string, body?: any, opts?: { skipHotel?: boolean }): Promise<T> {
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  let url = path
  let payload: string | undefined

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  // 平台管理员的业务请求自动注入当前酒店
  if (!opts?.skipHotel && hotelResolver() !== null) {
    if (method === 'GET') {
      url += (path.includes('?') ? '&' : '?') + `hotel_id=${hotelResolver()}`
    } else if (payload) {
      try {
        const obj = JSON.parse(payload)
        if (obj.hotel_id === undefined) obj.hotel_id = hotelResolver()
        payload = JSON.stringify(obj)
      } catch { /* ignore */ }
    } else {
      url += (path.includes('?') ? '&' : '?') + `hotel_id=${hotelResolver()}`
    }
  }

  const res = await fetch(url, { method, headers, body: payload })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    // 登录态失效：清理本地状态并回到登录页（登录接口本身除外）
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      localStorage.removeItem('pms_token')
      localStorage.removeItem('pms_user')
      localStorage.removeItem('pms_active_hotel')
      window.location.href = '/login'
    }
    throw new ApiError(res.status, data)
  }
  return data as T
}

export const api = {
  get: <T = any>(p: string, opts?: { skipHotel?: boolean }) => request<T>('GET', p, undefined, opts),
  post: <T = any>(p: string, body?: any, opts?: { skipHotel?: boolean }) => request<T>('POST', p, body ?? {}, opts),
  patch: <T = any>(p: string, body?: any) => request<T>('PATCH', p, body),
  delete: <T = any>(p: string) => request<T>('DELETE', p),
}

// ---------- 类型 ----------
export interface Hotel { id: number; name: string; city: string; address: string; contact_name: string; is_active: boolean; room_count: number; staff_count: number; status: string }
export interface Channel { id: number; name: string; color: string; sort_order: number; is_active: boolean }
export interface RoomType { id: number; name: string; base_price: number; hourly_price: number; capacity: number; description: string; room_count: number }
export interface Room { id: number; room_number: string; floor: number; status: string; notes: string; room_type_id: number; room_type_name: string; base_price: number; hourly_price?: number }
export interface CalBlock {
  id: number; code: string; guest_name: string; channel_id: number | null
  channel_name: string; channel_color: string
  check_in: string; check_out: string; status: string; rate: number
  stay_type?: string; hours?: number
  balance_due: number; col_start: number; nights: number
}
export interface BoardRoom {
  id: number; number: string; floor: number; status: string; notes: string
  room_type_name: string; base_price: number; hourly_price?: number
  current_guest: string | null; current_check_out: string | null; current_code: string | null
  blocks: CalBlock[]
}
export interface BoardGroup { room_type_id: number; name: string; rooms: BoardRoom[] }
export interface Board {
  start: string; days: number
  day_list: { date: string; weekday: string; is_today: boolean }[]
  remain: number[]
  groups: BoardGroup[]
}
export interface Reservation {
  id: number; code: string; guest_id: number; guest_name: string; guest_phone: string
  vip_level: string; room_type_id: number; room_type_name: string
  room_id: number | null; room_number: string | null
  room_status?: string | null
  check_in: string; check_out: string; nights: number; status: string
  channel_id: number | null; channel_name: string | null; channel_color: string | null
  rate: number; stay_type: string; hours: number
  notes: string; balance_due: number
  operator_name: string | null; created_at: string
}
export interface OpLog { id: number; time: string; action: string; summary: string; operator: string }
/** 在住登记信息更正（字段为 null 表示不修改） */
export interface RegistrationBody {
  guest_name?: string
  guest_phone?: string
  /** 普通房：改入住天数（离店日 = 入住日 + 天数） */
  nights?: number
  rate?: number
  channel_id?: number | null
  notes?: string
}
/** 更正实收：把整单已收金额调整到目标总额 */
export interface PaidTotalBody {
  amount: number
  method?: 'cash' | 'wechat' | 'alipay' | 'card'
}
export interface Folio {
  items: { id: number; category: string; description: string; amount: number; created_at: string; operator: string }[]
  payments: { id: number; method: string; amount: number; created_at: string; operator: string }[]
  total_charge: number
  total_paid: number
  balance_due: number
}
export interface Guest {
  id: number; name: string; phone: string; id_number: string; vip_level: string; notes: string
  stay_count: number; total_spend: number; last_stay: string | null
  history?: { reservation_id: number; room_number: string; check_in: string; check_out: string; status: string; amount: number }[]
}
export interface DashData {
  occupancy_today: number; occupied: number; total_rooms: number
  arrivals: number; arrivals_ready: number; departures: number
  unpaid_count: number; unpaid_amount: number; pending_confirm: number
  maintenance_count: number
  revenue_today: number; revenue_room: number; revenue_other: number
  today_label: string
  arrival_items: Reservation[]
  departure_items: Reservation[]
  unpaid_items: Reservation[]
}
export interface UserRow {
  id: number; name: string; username: string; role: string; role_label: string
  hotel_id: number | null; hotel_name: string | null; is_active: boolean; last_login_at: string | null
}

export function fmtMoney(n: number): string {
  return '¥' + n.toLocaleString('zh-CN')
}

export function maskPhone(p: string): string {
  return p && p.length === 11 ? p.slice(0, 3) + '****' + p.slice(7) : p
}

export function md(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${Number(m)}/${Number(d)}`
}

export function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d + n)
  const pad = (x: number) => (x < 10 ? '0' : '') + x
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
}

export function todayIso(): string {
  const dt = new Date()
  const pad = (x: number) => (x < 10 ? '0' : '') + x
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
}

export const RES_STATUS_LABEL: Record<string, string> = {
  pending: '待确认', confirmed: '已确认', checked_in: '已入住',
  checked_out: '已离店', cancelled: '已取消', no_show: '未到店',
}

export const ROOM_STATUS_LABEL: Record<string, string> = {
  vacant_clean: '空净 · 可售', vacant_dirty: '空脏 · 待清洁',
  occupied: '在住', maintenance: '维修',
}

export const PAY_METHOD_LABEL: Record<string, string> = {
  cash: '现金', wechat: '微信', alipay: '支付宝', card: '刷卡',
}

/** 操作日志 action → 中文标签（报表页与预订详情共用） */
export const OP_ACTION_LABEL: Record<string, string> = {
  reservation_create: '创建预订', reservation_confirm: '确认预订', reservation_cancel: '取消预订',
  reservation_move: '调整预订', reservation_extend: '延住', reservation_edit: '编辑登记',
  check_in: '办理入住', check_in_undo: '撤销入住', check_out: '退房结算', check_out_undo: '撤销退房',
  payment: '收款', payment_adjust: '更正实收', folio_add: '加收费用',
  room_status: '房态调整', room_create: '新增客房',
  room_type_create: '新增房型', room_type_update: '更新房型',
  guest_create: '新增客人',
  hotel_create: '新增酒店', hotel_update: '更新酒店',
  user_create: '新增员工', user_update: '更新员工',
  channel_create: '新增渠道', channel_update: '更新渠道',
  channel_disable: '停用渠道', channel_delete: '删除渠道',
  // 历史库遗留的清洁任务日志（功能已下线，保住旧记录的展示）
  housekeeping_create: '清洁任务', housekeeping_start: '清洁任务', housekeeping_done: '清洁任务',
}

/** 操作日志 action → 徽章颜色 */
export const OP_ACTION_COLOR: Record<string, string> = {
  reservation_create: 'blue', reservation_confirm: 'green', reservation_cancel: 'red',
  reservation_move: 'blue', reservation_extend: 'purple', reservation_edit: 'blue',
  check_in: 'green', check_in_undo: 'orange', check_out: 'gray', check_out_undo: 'orange',
  payment: 'green', payment_adjust: 'blue', folio_add: 'orange',
  room_status: 'gray', room_create: 'blue',
  room_type_create: 'blue', room_type_update: 'blue',
  guest_create: 'blue',
  hotel_create: 'blue', hotel_update: 'blue',
  user_create: 'blue', user_update: 'blue',
  channel_create: 'blue', channel_update: 'blue',
  channel_disable: 'gray', channel_delete: 'red',
  // 历史库遗留的清洁任务日志（功能已下线，保住旧记录的展示）
  housekeeping_create: 'gray', housekeeping_start: 'gray', housekeeping_done: 'gray',
}
