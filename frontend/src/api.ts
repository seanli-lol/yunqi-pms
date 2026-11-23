/* API 客户端：JWT + 酒店上下文注入 */
import { useQuery } from '@tanstack/react-query'

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
let refreshToken: string | null = localStorage.getItem('pms_refresh')
// 访问令牌到期时间（毫秒时间戳）；0 表示未知（老会话），此时靠 401 兜底续期
let tokenExp = Number(localStorage.getItem('pms_token_exp') || 0)
let hotelResolver: () => number | null = () => null

export function setAuthToken(t: string | null) {
  token = t
  if (t) localStorage.setItem('pms_token', t)
  else localStorage.removeItem('pms_token')
}

export function setRefreshToken(t: string | null) {
  refreshToken = t
  if (t) localStorage.setItem('pms_refresh', t)
  else localStorage.removeItem('pms_refresh')
}

/** 记录访问令牌到期时间（毫秒时间戳）；提前 60s 主动续期 */
export function setTokenExpiry(expMs: number | null) {
  tokenExp = expMs ?? 0
  if (expMs) localStorage.setItem('pms_token_exp', String(expMs))
  else localStorage.removeItem('pms_token_exp')
}

export function getAuthToken() {
  return token
}

export function getRefreshToken() {
  return refreshToken
}

/** 清除本地登录态（token / 刷新令牌 / 用户 / 酒店上下文） */
export function clearAuthStorage() {
  setAuthToken(null)
  setRefreshToken(null)
  setTokenExpiry(null)
  localStorage.removeItem('pms_user')
  localStorage.removeItem('pms_active_hotel')
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

// 静默续期单飞：并发请求共享同一个 refresh，避免轮换令牌被并发消费
let refreshing: Promise<boolean> | null = null

async function refreshSession(): Promise<boolean> {
  if (!refreshToken) return false
  if (refreshing) return refreshing
  refreshing = (async () => {
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      })
      if (!res.ok) {
        clearAuthStorage()
        return false
      }
      const d = await res.json()
      setAuthToken(d.token)
      setRefreshToken(d.refresh_token)
      setTokenExpiry(Date.now() + d.expires_in * 1000)
      return true
    } catch {
      clearAuthStorage()
      return false
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

async function request<T = any>(method: string, path: string, body?: any, opts?: { skipHotel?: boolean }): Promise<T> {
  // 访问令牌临近过期（<60s）先主动续期，省一次 401 往返
  if (token && refreshToken && tokenExp && tokenExp - Date.now() < 60_000 && !path.startsWith('/api/auth/')) {
    await refreshSession()
  }

  const send = async () => {
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
    return fetch(url, { method, headers, body: payload })
  }

  let res = await send()
  // 登录态失效：先用刷新令牌静默续期并重试一次（鉴权依赖在 handler 前抛 401，重试无副作用）
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    const ok = await refreshSession()
    if (ok) res = await send()
    if (!ok || res.status === 401) {
      clearAuthStorage()
      window.location.href = '/login'
    }
  }
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new ApiError(res.status, data)
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
/** 收款方式（设置页可配置，各店独立）；payments.method 存稳定 code，默认项 cash/wechat/alipay/card */
export interface PayMethod { id: number; code: string; name: string; remark: string; sort_order: number; is_active: boolean }
export interface RoomType { id: number; name: string; base_price: number; hourly_price: number; capacity: number; description: string; room_count: number }
export interface Room { id: number; room_number: string; floor: number; status: string; notes: string; room_type_id: number; room_type_name: string; base_price: number; hourly_price?: number }
export interface CalBlock {
  id: number; code: string; guest_id?: number; guest_name: string; channel_id: number | null
  channel_name: string; channel_color: string
  check_in: string; check_out: string; status: string; rate: number
  stay_type?: string; hours?: number
  // 金额分列（退房角标明细卡用）：应收 = Σ folio_items，已收 = Σ payments，余额 = 应收 - 已收
  balance_due: number; items_total: number; paid_total: number
  col_start: number; nights: number
  // 提前退房截断：灰块存根止于实际离店日（stub_cut=末日压左1/3）。
  // 当日入住当日退（stub_nights==1，钟点房/当日往返）由前端聚合为格角「退房」角标；
  // 原「可售」虚纹已退役——截断后右侧空白即可售
  truncated?: boolean; stub_nights?: number; stub_cut?: boolean
  // 前端合并「同一客人、同一房、日期首尾相接」的连住预订后合成的展示方块（后端不产出）：
  // chain = 被合并的多笔原订单（按 check_in 升序），length>0 即表示这是合并长条
  chain?: CalBlock[]
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
  actual_check_out?: string | null
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
  method?: string
}
export interface Folio {
  items: { id: number; category: string; description: string; amount: number; created_at: string; operator: string }[]
  payments: { id: number; method: string; amount: number; remark: string; created_at: string; operator: string }[]
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

/** 金额显示：统一两位小数（保留到分） */
export function fmtMoney(n: number): string {
  return '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** 金额按分取整（四舍五入 half-up）：Math.round(v*100) 有二进制尾差（4.025*100=402.4999…），
 *  走 e 记法字符串中转规避；金额输入解析 / 整单总额折算单价统一走此函数 */
export function round2(v: number): number {
  return Number(Math.round(parseFloat(`${v}e2`)) + 'e-2')
}

/** 金额输入过滤：只留数字与一个小数点（「最多保留到分」由提交时 round2 兜底） */
export function moneyInputText(v: string): string {
  const s = v.replace(/[^\d.]/g, '')
  const i = s.indexOf('.')
  return i === -1 ? s : s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, '')
}

export function maskPhone(p: string): string {
  return p && p.length === 11 ? p.slice(0, 3) + '****' + p.slice(7) : p
}

export function md(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${Number(m)}/${Number(d)}`
}

/** 带时间的 iso（账目/收款 created_at）→ 「M/D」短日期 */
export function mdt(iso: string): string {
  return iso.slice(5, 10).replace('-', '/')
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

/** 老 code 兜底映射：收款方式被物理删除后，历史账单仍可读 */
export const PAY_METHOD_LABEL: Record<string, string> = {
  cash: '现金', wechat: '微信', alipay: '支付宝', card: '刷卡',
}

/** 收款方式展示名：配置名优先（改名后历史记录也显示新名），再走老 code 兜底 */
export function payMethodLabel(pms: PayMethod[] | undefined | null, code: string): string {
  return pms?.find(m => m.code === code)?.name ?? PAY_METHOD_LABEL[code] ?? code
}

/** 各处收款下拉共用（只含启用项）；staleTime 0——设置页改完，收款弹层立即生效 */
export function usePayMethods() {
  return useQuery({
    queryKey: ['pay-methods'],
    queryFn: () => api.get<PayMethod[]>('/api/payment-methods'),
    staleTime: 0,
  })
}

/** 操作日志 action → 中文标签（报表页与预订详情共用） */
export const OP_ACTION_LABEL: Record<string, string> = {
  reservation_create: '创建预订', reservation_confirm: '确认预订', reservation_cancel: '取消预订',
  reservation_move: '调整预订', reservation_extend: '延住', reservation_edit: '编辑登记',
  check_in: '办理入住', check_in_undo: '撤销入住', check_out: '退房结算', check_out_undo: '撤销退房',
  payment: '收款', payment_adjust: '更正实收', payment_delete: '删除收款', folio_add: '加收费用',
  room_status: '房态调整', room_create: '新增客房', room_update: '编辑客房', room_delete: '删除客房',
  room_type_create: '新增房型', room_type_update: '更新房型',
  guest_create: '新增客人', guest_update: '更新客人',
  hotel_create: '新增酒店', hotel_update: '更新酒店',
  user_create: '新增员工', user_update: '更新员工',
  channel_create: '新增渠道', channel_update: '更新渠道',
  channel_disable: '停用渠道', channel_delete: '删除渠道',
  paymethod_create: '新增收款方式', paymethod_update: '更新收款方式',
  paymethod_disable: '停用收款方式', paymethod_delete: '删除收款方式',
  // 历史库遗留的清洁任务日志（功能已下线，保住旧记录的展示）
  housekeeping_create: '清洁任务', housekeeping_start: '清洁任务', housekeeping_done: '清洁任务',
}

/** 操作日志 action → 徽章颜色 */
export const OP_ACTION_COLOR: Record<string, string> = {
  reservation_create: 'blue', reservation_confirm: 'green', reservation_cancel: 'red',
  reservation_move: 'blue', reservation_extend: 'purple', reservation_edit: 'blue',
  check_in: 'green', check_in_undo: 'orange', check_out: 'gray', check_out_undo: 'orange',
  payment: 'green', payment_adjust: 'blue', payment_delete: 'red', folio_add: 'orange',
  room_status: 'gray', room_create: 'blue', room_update: 'blue', room_delete: 'red',
  room_type_create: 'blue', room_type_update: 'blue',
  guest_create: 'blue', guest_update: 'blue',
  hotel_create: 'blue', hotel_update: 'blue',
  user_create: 'blue', user_update: 'blue',
  channel_create: 'blue', channel_update: 'blue',
  channel_disable: 'gray', channel_delete: 'red',
  paymethod_create: 'blue', paymethod_update: 'blue',
  paymethod_disable: 'gray', paymethod_delete: 'red',
  // 历史库遗留的清洁任务日志（功能已下线，保住旧记录的展示）
  housekeeping_create: 'gray', housekeeping_start: 'gray', housekeeping_done: 'gray',
}
