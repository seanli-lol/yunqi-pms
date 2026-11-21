/* 共享业务弹层：入住向导（前台工作台 / 房态盘预订详情共用）+ 延住 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, addDaysIso, fmtMoney, md, usePayMethods, type Reservation, type Room } from './api'
import { Dialog, Drawer, Field } from './ui'

/** 入住选房：放宽后可用（脏房/前客未退）与不可用（维修）的标记 */
const ROOM_PICK_TAG: Record<string, string> = {
  vacant_dirty: '未清洁',
  occupied: '前客未退',
}

/** 房态盘传 drawer=1 时弹层走右侧抽屉（穿透遮罩），前台工作台默认居中弹层不变 */
export function CheckInDialog({ res, busy, drawer = false, onClose, onConfirm }: {
  res: Reservation
  busy: boolean
  drawer?: boolean
  onClose: () => void
  onConfirm: (body: { room_id: number; amount_received: number; payment_method: string }, label: string) => void
}) {
  const [roomId, setRoomId] = useState<number | null>(null)
  // 办理入住无需填押金：直接填「实收金额」，默认带出预订应收（balance_due）
  const [amount, setAmount] = useState(res.balance_due > 0 ? String(res.balance_due) : '')
  // 收款方式来自设置（各店可配置）；默认值必须同步进 state——不能只靠 select 渲染兜底
  const pms = usePayMethods()
  const [method, setMethod] = useState('')
  useEffect(() => {
    const codes = pms.data?.map(m => m.code) ?? []
    if (codes.length && !codes.includes(method)) setMethod(codes[0])
  }, [pms.data, method])
  const avail = useQuery({
    queryKey: ['available', res.room_type_id, res.check_in, res.check_out, res.id],
    // 入住放宽：include_dirty 带入空脏房、allow_prev_guest 不用在住阻挡（前客未退可选）
    // exclude_res_id：排除本预订自身，否则预订已锁定的房会被自己的预订挡住
    queryFn: () => api.get<Room[]>(`/api/rooms/available?room_type_id=${res.room_type_id}&check_in=${res.check_in}&check_out=${res.check_out}&exclude_res_id=${res.id}&include_dirty=1&allow_prev_guest=1`),
    enabled: !!res.room_type_id,
  })
  // 预订已锁定房号且可入住时，默认选中该房
  useEffect(() => {
    if (res.room_id && avail.data?.some(r => r.id === res.room_id)) setRoomId(res.room_id)
  }, [avail.data, res.room_id])

  const lockedNotReady = res.room_id && avail.data && !avail.data.some(r => r.id === res.room_id)

  const body = (
    <>
      <div className="section-sub" style={{ marginBottom: 10 }}>
        选择房间（{res.room_type_name} · 可选 {avail.data?.length ?? '…'} 间）
      </div>
      <div className="pick-grid">
        {(avail.data ?? []).map(r => (
          <button key={r.id} className={`pick-room${roomId === r.id ? ' active' : ''}`} onClick={() => setRoomId(r.id)}>
            <span className="no">{r.room_number}</span>
            <span className="fl">
              {r.floor}F{ROOM_PICK_TAG[r.status] ? ` · ${ROOM_PICK_TAG[r.status]}` : ''}
            </span>
          </button>
        ))}
        {avail.data?.length === 0 && <span className="hint">该房型当前无可选房间（维修房除外）</span>}
      </div>
      {lockedNotReady && (
        <p className="hint warn">预订已锁定 {res.room_number}，该房当前不可入住（维修中），可改派其他房间。</p>
      )}
      <p className="hint">脏房 / 前客未退的房间也可直接入住，选房时已标注，请酌情安排。</p>
      <div className="form-row mt-24">
        <Field label="实收金额（整单总额）">
          <input
            className="input" inputMode="numeric" placeholder="0"
            value={amount}
            onChange={e => setAmount(e.target.value.replace(/[^\d]/g, ''))}
          />
        </Field>
        <Field label="收款方式">
          <select className="select" value={method} onChange={e => setMethod(e.target.value)}>
            {(pms.data ?? []).map(m => <option key={m.code} value={m.code}>{m.name}</option>)}
          </select>
        </Field>
      </div>
      <p className="hint">
        应收 {fmtMoney(res.balance_due)}（{res.stay_type === 'hourly' ? `钟点房费 ${fmtMoney(res.rate * res.hours)}` : `房费 ${fmtMoney(res.rate * res.nights)}（整单总价）`}）· 实收填本次入住整单总额 · 实收 0 = 到店后结清 · 免押金入住
      </p>
      <p className="hint">手机号：{res.guest_phone || '未留（到店补录）'} · 预订来源 {res.channel_name ?? '—'}</p>
    </>
  )

  if (drawer) {
    return (
      <Drawer open passthrough onClose={onClose} title={`办理入住 · ${res.guest_name}`}
        sub={`${res.code} · ${res.room_type_name} · ${md(res.check_in)} – ${md(res.check_out)} · 共 ${res.nights} 晚 · ¥${res.rate}/晚`}
        foot={
          <>
            <button className="btn btn-ghost" onClick={onClose}>取消</button>
            <button
              className="btn btn-primary" disabled={busy || roomId === null}
              onClick={() => onConfirm({ room_id: roomId!, amount_received: Math.max(0, Math.round(Number(amount) || 0)), payment_method: method }, '入住成功，房态转为在住')}
            >确认入住</button>
          </>
        }
      >
        {body}
      </Drawer>
    )
  }
  return (
    <Dialog
      open onClose={onClose} wide
      title={`办理入住 · ${res.guest_name}`}
      sub={`${res.code} · ${res.room_type_name} · ${md(res.check_in)} – ${md(res.check_out)} · 共 ${res.nights} 晚 · ¥${res.rate}/晚`}
      foot={
        <>
          <span className="hint" style={{ marginRight: 'auto' }}>操作人：当前登录账号 · 入住将记录到预订日志</span>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary" disabled={busy || roomId === null}
            onClick={() => onConfirm({ room_id: roomId!, amount_received: Math.max(0, Math.round(Number(amount) || 0)), payment_method: method }, '入住成功，房态转为在住')}
          >确认入住</button>
        </>
      }
    >
      {body}
    </Dialog>
  )
}

/* ---------- 延住弹窗（普通按晚 / 钟点按小时，自定义应收总额） ---------- */
export function ExtendDialog({ res, busy, drawer = false, onClose, onConfirm }: {
  res: Reservation
  busy: boolean
  drawer?: boolean
  onClose: () => void
  onConfirm: (body: { nights: number; hours: number; rate: number }, label: string) => void
}) {
  const hourly = res.stay_type === 'hourly'
  const [nights, setNights] = useState('1')
  const [hours, setHours] = useState('1')
  /** 延住总价（整单）：按数量折算单价提交，后端仍按「数量 × 单价」入账 */
  const [totalText, setTotalText] = useState(String(hourly ? res.rate : res.rate))
  const n = Math.max(0, Math.round(Number(nights) || 0))
  const h = Math.max(0, Math.round(Number(hours) || 0))
  const units = hourly ? h : n
  const unitLabel = hourly ? '小时' : '晚'
  const total = Math.max(0, Math.round(Number(totalText) || 0))
  const rate = units > 0 ? Math.round(total / units) : 0
  const amount = rate * units
  // 提交体按预订类型裁剪：普通预订不携带 hours，钟点预订不携带 nights（后端按类型校验）
  const body = hourly ? { nights: 0, hours: h, rate } : { nights: n, hours: 0, rate }
  const newOut = addDaysIso(res.check_out, n)
  const remain = 12 - res.hours
  const disabled = busy || amount <= 0 || (!hourly && n <= 0) || (hourly && (h <= 0 || h > remain))
  const okLabel = hourly ? `已延住 ${h} 小时` : `已延住 ${n} 晚，新离店 ${md(newOut)}`

  /** 改数量：按当前折合单价重算总价 */
  const onUnitsChange = (nextUnits: number) => {
    const u = (units > 0 ? Math.round(total / units) : 0) || res.rate
    setTotalText(String(Math.max(0, nextUnits) * u))
  }

  const fields = (
    <>
      {hourly ? (
        <Field label="延住小时数" required hint={`当前 ${res.hours} 小时，累计不可超过 12 小时。`}>
          <input className="input" inputMode="numeric" value={hours}
                 onChange={e => {
                   const digits = e.target.value.replace(/[^\d]/g, '')
                   setHours(digits)
                   onUnitsChange(Math.round(Number(digits) || 0))
                 }} placeholder="1" />
        </Field>
      ) : (
        <Field label="延住晚数" required hint={`离店日 ${md(res.check_out)} → 延住后 ${md(newOut)}`}>
          <input className="input" inputMode="numeric" value={nights}
                 onChange={e => {
                   const digits = e.target.value.replace(/[^\d]/g, '')
                   setNights(digits)
                   onUnitsChange(Math.round(Number(digits) || 0))
                 }} placeholder="1" />
        </Field>
      )}
      <Field
        label="延住总价（整单，元）"
        hint={`折合 ¥${rate}/${unitLabel}（${units} ${unitLabel}）· 本次应收 ¥${amount.toLocaleString()}；改数量时按折合单价自动重算。`}
      >
        <input className="input" inputMode="numeric" value={totalText}
               onChange={e => setTotalText(e.target.value.replace(/[^\d]/g, ''))} />
      </Field>
      <p className="hint">
        本次应收：<b>¥{amount.toLocaleString()}</b>
        {hourly ? `（${h} 小时 × ¥${rate}，延住后共 ${res.hours + h} 小时）` : `（${n} 晚 × ¥${rate}，新离店 ${md(newOut)}）`}
      </p>
    </>
  )

  if (drawer) {
    return (
      <Drawer open passthrough onClose={onClose}
        title={`延住 · ${res.guest_name}`}
        sub={hourly
          ? `${res.code} · 钟点 ${res.hours} 小时 · ¥${res.rate}/小时`
          : `${res.code} · ${res.room_number ?? ''} · 现 ${md(res.check_in)} – ${md(res.check_out)} · ¥${res.rate}/晚`}
        foot={
          <>
            <button className="btn btn-ghost" onClick={onClose}>取消</button>
            <button className="btn btn-primary" disabled={disabled} onClick={() => onConfirm(body, okLabel)}>确认延住</button>
          </>
        }
      >
        {fields}
      </Drawer>
    )
  }
  return (
    <Dialog
      open onClose={onClose}
      title={`延住 · ${res.guest_name}`}
      sub={hourly
        ? `${res.code} · 钟点 ${res.hours} 小时 · ¥${res.rate}/小时`
        : `${res.code} · ${res.room_number ?? ''} · 现 ${md(res.check_in)} – ${md(res.check_out)} · ¥${res.rate}/晚`}
      foot={
        <>
          <span className="hint" style={{ marginRight: 'auto' }}>应收将追加到账单，不改原房费</span>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={disabled} onClick={() => onConfirm(body, okLabel)}>确认延住</button>
        </>
      }
    >
      {fields}
    </Dialog>
  )
}
