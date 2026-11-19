/* 共享业务弹层：入住向导（前台工作台 / 房态盘预订详情共用）+ 延住 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, addDaysIso, fmtMoney, md, type Reservation, type Room } from './api'
import { Dialog, Field } from './ui'

/** 入住选房：放宽后可用（脏房/前客未退）与不可用（维修）的标记 */
const ROOM_PICK_TAG: Record<string, string> = {
  vacant_dirty: '未清洁',
  occupied: '前客未退',
}

export function CheckInDialog({ res, busy, onClose, onConfirm }: {
  res: Reservation
  busy: boolean
  onClose: () => void
  onConfirm: (body: { room_id: number; amount_received: number; payment_method: string }, label: string) => void
}) {
  const [roomId, setRoomId] = useState<number | null>(null)
  // 办理入住无需填押金：直接填「实收金额」，默认带出预订应收（balance_due）
  const [amount, setAmount] = useState(res.balance_due > 0 ? String(res.balance_due) : '')
  const [method, setMethod] = useState('wechat')
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
        <Field label="实收金额">
          <input
            className="input" inputMode="numeric" placeholder="0"
            value={amount}
            onChange={e => setAmount(e.target.value.replace(/[^\d]/g, ''))}
          />
        </Field>
        <Field label="收款方式">
          <select className="select" value={method} onChange={e => setMethod(e.target.value)}>
            <option value="wechat">微信</option><option value="alipay">支付宝</option>
            <option value="cash">现金</option><option value="card">刷卡</option>
          </select>
        </Field>
      </div>
      <p className="hint">
        应收 {fmtMoney(res.balance_due)}（{res.stay_type === 'hourly' ? `钟点房费 ${fmtMoney(res.rate * res.hours)}` : `房费 ${fmtMoney(res.rate * res.nights)}`}）· 实收 0 = 到店后结清 · 免押金入住
      </p>
      <p className="hint">手机号：{res.guest_phone || '未留（到店补录）'} · 预订来源 {res.channel_name ?? '—'}</p>
    </Dialog>
  )
}

/* ---------- 延住弹窗（普通按晚 / 钟点按小时，自定义应收单价） ---------- */
export function ExtendDialog({ res, busy, onClose, onConfirm }: {
  res: Reservation
  busy: boolean
  onClose: () => void
  onConfirm: (body: { nights: number; hours: number; rate: number }, label: string) => void
}) {
  const hourly = res.stay_type === 'hourly'
  const [nights, setNights] = useState('1')
  const [hours, setHours] = useState('1')
  const [rate, setRate] = useState(String(res.rate))
  const n = Math.max(0, Math.round(Number(nights) || 0))
  const h = Math.max(0, Math.round(Number(hours) || 0))
  const r = Math.max(0, Math.round(Number(rate) || 0))
  // 提交体按预订类型裁剪：普通预订不携带 hours，钟点预订不携带 nights（后端按类型校验）
  const body = hourly ? { nights: 0, hours: h, rate: r } : { nights: n, hours: 0, rate: r }
  const amount = (hourly ? h : n) * r
  const newOut = addDaysIso(res.check_out, n)
  const remain = 12 - res.hours

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
          <button
            className="btn btn-primary"
            disabled={busy || amount <= 0 || (!hourly && n <= 0) || (hourly && (h <= 0 || h > remain))}
            onClick={() => onConfirm(body, hourly ? `已延住 ${h} 小时` : `已延住 ${n} 晚，新离店 ${md(newOut)}`)}
          >确认延住</button>
        </>
      }
    >
      {hourly ? (
        <Field label="延住小时数" required hint={`当前 ${res.hours} 小时，累计不可超过 12 小时。`}>
          <input className="input" inputMode="numeric" value={hours}
                 onChange={e => setHours(e.target.value.replace(/[^\d]/g, ''))} placeholder="1" />
        </Field>
      ) : (
        <Field label="延住晚数" required hint={`离店日 ${md(res.check_out)} → 延住后 ${md(newOut)}`}>
          <input className="input" inputMode="numeric" value={nights}
                 onChange={e => setNights(e.target.value.replace(/[^\d]/g, ''))} placeholder="1" />
        </Field>
      )}
      <Field label="应收价格（单价）" hint={`默认为系统设置房价 ¥${res.rate}，可修改。`}>
        <input className="input" inputMode="numeric" value={rate}
               onChange={e => setRate(e.target.value.replace(/[^\d]/g, ''))} />
      </Field>
      <p className="hint">
        本次应收：<b>¥{amount.toLocaleString()}</b>
        {hourly ? `（${h} 小时 × ¥${r}，延住后共 ${res.hours + h} 小时）` : `（${n} 晚 × ¥${r}，新离店 ${md(newOut)}）`}
      </p>
    </Dialog>
  )
}
