/* 共享业务弹层：入住向导（前台工作台 / 房态盘预订详情共用）+ 延住 + 编辑预订 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, addDaysIso, fmtMoney, md, moneyInputText, round2, usePayMethods, type Channel, type Reservation, type Room } from './api'
import { Dialog, Drawer, Field } from './ui'
import { GuestNameInput } from './GuestNameInput'

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
            className="input" inputMode="decimal" placeholder="0"
            value={amount}
            onChange={e => setAmount(moneyInputText(e.target.value))}
          />
        </Field>
        <Field label="收款方式">
          <select className="select" value={method} onChange={e => setMethod(e.target.value)}>
            {(pms.data ?? []).map(m => <option key={m.code} value={m.code}>{m.name}</option>)}
          </select>
        </Field>
      </div>
      <p className="hint">
        {/* 房费取 room_charge_total：连住合并/分段计价后 ≠ 单价 × 晚数 */}
        应收 {fmtMoney(res.balance_due)}（{res.stay_type === 'hourly' ? `钟点房费 ${fmtMoney(res.room_charge_total ?? res.rate * res.hours)}` : `房费 ${fmtMoney(res.room_charge_total ?? res.rate * res.nights)}（整单总价）`}）· 实收填本次入住整单总额 · 实收 0 = 到店后结清 · 免押金入住
      </p>
      <p className="hint">手机号：{res.guest_phone || '未留（到店补录）'} · 预订来源 {res.channel_name ?? '—'}</p>
    </>
  )

  if (drawer) {
    return (
      <Drawer open passthrough onClose={onClose} title={`办理入住 · ${res.guest_name}`}
        sub={`${res.code} · ${res.room_type_name} · ${md(res.check_in)} – ${md(res.check_out)} · 共 ${res.nights} 晚 · ${fmtMoney(res.rate)}/晚`}
        foot={
          <>
            <button className="btn btn-ghost" onClick={onClose}>取消</button>
            <button
              className="btn btn-primary" disabled={busy || roomId === null}
              onClick={() => onConfirm({ room_id: roomId!, amount_received: Math.max(0, round2(Number(amount) || 0)), payment_method: method }, '入住成功，房态转为在住')}
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
      sub={`${res.code} · ${res.room_type_name} · ${md(res.check_in)} – ${md(res.check_out)} · 共 ${res.nights} 晚 · ${fmtMoney(res.rate)}/晚`}
      foot={
        <>
          <span className="hint" style={{ marginRight: 'auto' }}>操作人：当前登录账号 · 入住将记录到预订日志</span>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary" disabled={busy || roomId === null}
            onClick={() => onConfirm({ room_id: roomId!, amount_received: Math.max(0, round2(Number(amount) || 0)), payment_method: method }, '入住成功，房态转为在住')}
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
  const total = Math.max(0, round2(Number(totalText) || 0))
  const rate = units > 0 ? round2(total / units) : 0
  const amount = round2(rate * units)
  // 提交体按预订类型裁剪：普通预订不携带 hours，钟点预订不携带 nights（后端按类型校验）
  const body = hourly ? { nights: 0, hours: h, rate } : { nights: n, hours: 0, rate }
  const newOut = addDaysIso(res.check_out, n)
  const remain = 12 - res.hours
  const disabled = busy || amount <= 0 || (!hourly && n <= 0) || (hourly && (h <= 0 || h > remain))
  const okLabel = hourly ? `已延住 ${h} 小时` : `已延住 ${n} 晚，新离店 ${md(newOut)}`

  /** 改数量：按当前折合单价重算总价 */
  const onUnitsChange = (nextUnits: number) => {
    const u = (units > 0 ? round2(total / units) : 0) || res.rate
    setTotalText(String(round2(Math.max(0, nextUnits) * u)))
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
        hint={`折合 ${fmtMoney(rate)}/${unitLabel}（${units} ${unitLabel}）· 本次应收 ${fmtMoney(amount)}；改数量时按折合单价自动重算。`}
      >
        <input className="input" inputMode="decimal" value={totalText}
               onChange={e => setTotalText(moneyInputText(e.target.value))} />
      </Field>
      <p className="hint">
        本次应收：<b>{fmtMoney(amount)}</b>
        {hourly ? `（${h} 小时 × ${fmtMoney(rate)}，延住后共 ${res.hours + h} 小时）` : `（${n} 晚 × ${fmtMoney(rate)}，新离店 ${md(newOut)}）`}
      </p>
    </>
  )

  if (drawer) {
    return (
      <Drawer open passthrough onClose={onClose}
        title={`延住 · ${res.guest_name}`}
        sub={hourly
          ? `${res.code} · 钟点 ${res.hours} 小时 · ${fmtMoney(res.rate)}/小时`
          : `${res.code} · ${res.room_number ?? ''} · 现 ${md(res.check_in)} – ${md(res.check_out)} · ${fmtMoney(res.rate)}/晚`}
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
        ? `${res.code} · 钟点 ${res.hours} 小时 · ${fmtMoney(res.rate)}/小时`
        : `${res.code} · ${res.room_number ?? ''} · 现 ${md(res.check_in)} – ${md(res.check_out)} · ${fmtMoney(res.rate)}/晚`}
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

/* ---------- 编辑预订（待确认 / 已确认：姓名手机号 / 日期天数 / 总价 / 来源 / 备注） ----------
   预订管理列表行与房态盘详情抽屉共用；姓名/手机号沿用「更正客户档案」语义
   （改的是 guests 档案本身，该客人历史订单跟随，同店手机号撞档由后端 400 拦截）。 */
export function EditBookingDialog({ res, channels, busy, onClose, onConfirm }: {
  res: Reservation
  channels: Channel[]
  busy: boolean
  onClose: () => void
  onConfirm: (body: {
    guest_name?: string; guest_phone?: string
    check_in?: string; check_out?: string
    rate?: number; channel_id?: number | null; notes?: string
  }) => void
}) {
  const hourly = res.stay_type === 'hourly'
  const [name, setName] = useState(res.guest_name)
  const [phone, setPhone] = useState(res.guest_phone)
  const [checkIn, setCheckIn] = useState(res.check_in)
  const [nightsText, setNightsText] = useState(String(res.nights))
  // 初值取房费合计（分段计价的合并单不能拿单价 × 晚数推算）
  const baseTotal = res.room_charge_total ?? round2(res.rate * (hourly ? res.hours : res.nights))
  const [totalText, setTotalText] = useState(String(round2(baseTotal)))
  /** 用户没动过总额/天数就别提交 rate：无谓改价会触发房费行收拢（分段价被抹平） */
  const [totalTouched, setTotalTouched] = useState(false)
  const [nightsTouched, setNightsTouched] = useState(false)
  // 编辑场景回填预订现值（含 null=未指定）——不能套用新建表单「默认第一个渠道」的规则
  const [channelId, setChannelId] = useState<number | null>(res.channel_id)
  const [notes, setNotes] = useState(res.notes)

  const nights = Math.max(1, Math.round(Number(nightsText) || 1))
  const units = hourly ? res.hours : nights
  const unitLabel = hourly ? '小时' : '晚'
  const total = Math.max(0, round2(Number(totalText) || 0))
  const unitPrice = units > 0 ? round2(total / units) : 0
  const finalTotal = round2(unitPrice * units)
  const segPriced = res.room_charge_total != null
    && Math.abs(res.room_charge_total - round2(res.rate * (hourly ? res.hours : res.nights))) > 0.005

  /** 改天数：按折合单价重算总额（用户口径：总额根据天数计算） */
  const onNightsChange = (v: string) => {
    const digits = v.replace(/[^\d]/g, '')
    setNightsText(digits)
    setNightsTouched(true)
    const n = Math.max(1, Math.round(Number(digits) || 1))
    const prevUnit = round2(total / (units || 1)) || res.rate
    setTotalText(String(round2(n * prevUnit)))
  }
  /** 改入住日：天数不变，离店日跟随 */
  const onCheckInChange = (v: string) => {
    setCheckIn(v)
    if (v) setNightsText(String(Math.max(1, Math.round(Number(nightsText) || 1))))
  }

  const submit = () => {
    if (!name.trim()) return
    onConfirm({
      guest_name: name, guest_phone: phone,
      // 钟点房占整日固定：不携带日期（后端对改期显式 400），只允许改客人/总价/来源/备注
      ...(hourly ? {} : { check_in: checkIn, check_out: addDaysIso(checkIn, nights) }),
      // 未改动天数与总额 → 不提交 rate（避免无谓改价把分段房费收拢成一条）
      ...(totalTouched || nightsTouched ? { rate: unitPrice } : {}),
      channel_id: channelId, notes,
    })
  }

  const fields = (
    <>
      <div className="form-row">
        <Field label="客人姓名" required hint="修改姓名/手机号会同步更新该客户的客户档案，历史订单跟随更新。">
          <GuestNameInput value={name} onChange={setName} onPick={g => { setName(g.name); setPhone(g.phone || '') }} />
        </Field>
        <Field label="手机号" hint="同店已有客户使用此手机号时将提示核对，避免档案串档。">
          <input className="input" value={phone} onChange={e => setPhone(e.target.value)} placeholder="可留空，到店时补录" />
        </Field>
      </div>
      <div className="form-row">
        <Field label="入住日期" required>
          <input className="input" type="date" value={checkIn} onChange={e => onCheckInChange(e.target.value)} />
        </Field>
        {!hourly ? (
          <Field label="入住天数" required hint={`离店日 ${md(addDaysIso(checkIn, nights))}；所选时段被占用时保存会被拦截。`}>
            <input className="input" inputMode="numeric" value={nightsText} onChange={e => onNightsChange(e.target.value)} />
          </Field>
        ) : (
          <Field label="钟点时长">
            <input className="input" value={`${res.hours} 小时`} disabled />
          </Field>
        )}
      </div>
      {!hourly && (
        <div className="form-row">
          <Field label="离店日期" required>
            <input className="input" type="date"
                   value={addDaysIso(checkIn, nights)}
                   onChange={e => {
                     const n = Math.round((new Date(e.target.value).getTime() - new Date(checkIn).getTime()) / 86400000)
                     if (n >= 1) onNightsChange(String(n))
                   }} />
          </Field>
          <Field
            label="房价总额（整单，元）"
            hint={`折合 ${fmtMoney(unitPrice)}/${unitLabel}（${units} ${unitLabel}）· 最终应收 ${fmtMoney(finalTotal)}${segPriced ? ' · 本单分段计价，改总额/天数会把各段房费合并为按此额度整段重算' : ''}。`}
          >
            <input
              className="input" inputMode="decimal" value={totalText}
              onChange={e => { setTotalText(moneyInputText(e.target.value)); setTotalTouched(true) }}
            />
          </Field>
        </div>
      )}
      {hourly && (
        <Field
          label="房价总额（整单，元）"
          hint={`折合 ${fmtMoney(unitPrice)}/${unitLabel}（${units} ${unitLabel}）· 最终应收 ${fmtMoney(finalTotal)}。`}
        >
          <input
            className="input" inputMode="decimal" value={totalText}
            onChange={e => { setTotalText(moneyInputText(e.target.value)); setTotalTouched(true) }}
          />
        </Field>
      )}
      <div className="form-row mt-16">
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
      <p className="hint">保存后修改写入预订日志；钟点房占整日固定，改日期请延住或重新开单。</p>
    </>
  )

  return (
    <Dialog
      open onClose={onClose} wide
      title="编辑预订"
      sub={`${res.code} · ${res.guest_name} · ${md(res.check_in)} – ${md(res.check_out)}${res.room_number ? ` · ${res.room_number}` : ''}`}
      foot={
        <>
          <span className="hint" style={{ marginRight: 'auto' }}>操作人：当前登录账号 · 修改将记录到预订日志</span>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={submit}>保存修改</button>
        </>
      }
    >
      {fields}
    </Dialog>
  )
}
