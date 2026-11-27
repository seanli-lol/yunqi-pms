import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'react-router-dom'
import {
  api, addDaysIso, fmtMoney, maskPhone, md, moneyInputText, round2, todayIso,
  usePayMethods, RES_STATUS_LABEL,
  type Channel, type Reservation, type RoomType,
} from '../api'
import { ConfirmDialog, Dialog, Field, PageHead, Segmented, Spinner, useToast, RES_STATUS_BADGE } from '../ui'
import { DateRangeInput, DateRangePopover, diffDaysIso, shiftIso, useDateRangePicker } from '../datePicker'
import { AddPaymentDialog, EditBookingDialog } from '../dialogs'
import { GuestNameInput } from '../GuestNameInput'

const STATUS_TABS = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待确认' },
  { key: 'confirmed', label: '已确认' },
  { key: 'checked_in', label: '已入住' },
  { key: 'checked_out', label: '已离店' },
  { key: 'cancelled', label: '已取消' },
] as const

export default function Reservations() {
  const toast = useToast()
  const qc = useQueryClient()
  const loc = useLocation()
  const [status, setStatus] = useState<string>('all')
  const [q, setQ] = useState('')
  const [dateMode, setDateMode] = useState<'today' | 'all'>('all')
  const [newOpen, setNewOpen] = useState(false)
  /** 取消预订确认弹层（应用内弹层替代 window.confirm） */
  const [cancelRes, setCancelRes] = useState<Reservation | null>(null)
  /** 编辑预订（待确认 / 已确认；与房态盘详情抽屉共用 EditBookingDialog） */
  const [editRes, setEditRes] = useState<Reservation | null>(null)
  /** 收款（预订阶段提前收款：押金/订金/预付全款；与房态盘共用 AddPaymentDialog） */
  const [payRes, setPayRes] = useState<Reservation | null>(null)

  useEffect(() => {
    const st = (loc.state as any)?.status
    if (st) { setStatus(st); setDateMode('all') }
  }, [loc.state])

  const list = useQuery({
    queryKey: ['reservations', status, q, dateMode],
    queryFn: () => {
      const p = new URLSearchParams()
      if (status !== 'all') p.set('status', status)
      if (q) p.set('q', q)
      if (dateMode === 'today') p.set('date', todayIso())
      return api.get<Reservation[]>(`/api/reservations?${p.toString()}`)
    },
  })
  const channels = useQuery({ queryKey: ['channels'], queryFn: () => api.get<Channel[]>('/api/channels') })
  const types = useQuery({ queryKey: ['room-types'], queryFn: () => api.get<RoomType[]>('/api/room-types') })

  const mut = useMutation({
    mutationFn: (p: { path: string; body?: any; label: string; method?: string }) => {
      if (p.method === 'patch') return api.patch(p.path, p.body)
      return api.post(p.path, p.body ?? {})
    },
    onSuccess: (data: any, p) => {
      // 连住自动并入：本次开单没有新建订单，而是扩了该客人已有的相邻单
      toast(data?.merged
        ? `已并入该客人的连住订单 ${data.code}（${data.nights} 晚，房费合计 ${fmtMoney(data.room_charge_total ?? 0)}）`
        : p.label)
      qc.invalidateQueries({ queryKey: ['reservations'] })
    },
    onError: (e: any) => toast(e.message ?? '操作失败'),
  })

  const rows = list.data ?? []
  const counts: Record<string, number> = {}
  // 全量计数（不含筛选）：轻量做法——仅在 all 页统计
  if (status === 'all') {
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1
  }

  /* ---------- 编辑预订（PATCH /api/reservations/{id}，后端同步客户档案与房费） ---------- */
  const editMut = useMutation({
    mutationFn: (p: { id: number; body: { guest_name?: string; guest_phone?: string; check_in?: string; check_out?: string; rate?: number; channel_id?: number | null; notes?: string } }) =>
      api.patch<Reservation>(`/api/reservations/${p.id}`, p.body),
    onSuccess: () => {
      toast('预订已更新')
      setEditRes(null)
      qc.invalidateQueries({ queryKey: ['reservations'] })
    },
    onError: (e: any) => toast(e.message ?? '保存失败'),
  })

  /* ---------- 收款（POST /api/reservations/{id}/payments；pending/confirmed 本就放行） ---------- */
  const payMut = useMutation({
    mutationFn: (p: { id: number; body: { method: string; amount: number; remark: string } }) =>
      api.post<{ ok: boolean; balance_due: number }>(`/api/reservations/${p.id}/payments`, p.body),
    onSuccess: (_data, p) => {
      toast(`已收款 ${fmtMoney(p.body.amount)}${p.body.remark ? `（${p.body.remark}）` : ''}`)
      setPayRes(null)
      qc.invalidateQueries({ queryKey: ['reservations'] })
    },
    onError: (e: any) => toast(e.message ?? '收款失败'),
  })

  return (
    <>
      <PageHead
        title="预订管理"
        desc={`共 ${rows.length} 条预订`}
        actions={<button className="btn btn-primary" onClick={() => setNewOpen(true)}>新建预订</button>}
      />

      <div className="filter-bar">
        <div className="search">
          <input className="input" type="search" placeholder="搜索客人、手机号或预订号"
                 value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <Segmented
          value={dateMode}
          options={[{ key: 'all', label: '全部日期' }, { key: 'today', label: '今日抵店' }]}
          onChange={setDateMode}
        />
        <div className="chips">
          {STATUS_TABS.map(t => (
            <button key={t.key} className={`chip${status === t.key ? ' active' : ''}`}
                    onClick={() => setStatus(t.key)}>
              {t.label}
              {status === 'all' && t.key !== 'all' && counts[t.key] ? <span className="n">{counts[t.key]}</span> : null}
            </button>
          ))}
        </div>
      </div>

      {list.isLoading ? <Spinner /> : (
        <div className="card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>预订号</th><th>客人</th><th>房型 / 间数</th><th>入住 – 离店</th>
                  <th className="num">晚数</th><th className="num">房费</th><th>来源</th><th>状态</th><th>操作人</th><th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id}>
                    <td data-label="预订号" className="strong">{r.code}</td>
                    <td data-label="客人">
                      <div className="cell-main">{r.guest_name} {r.vip_level && <span className="badge badge-purple" style={{ marginLeft: 4 }}>{r.vip_level}</span>}</div>
                      <div className="cell-sub">{maskPhone(r.guest_phone)}</div>
                    </td>
                    <td data-label="房型">{r.room_type_name}{r.room_number ? ` · ${r.room_number}` : ''}{r.stay_type === 'hourly' && <span className="badge badge-purple" style={{ marginLeft: 4 }}>钟点 {r.hours}h</span>}</td>
                    <td data-label="入住 – 离店">{md(r.check_in)} – {md(r.check_out)}</td>
                    <td className="num" data-label="晚数">{r.nights}</td>
                    {/* 房费取 room_charge_total（Σ 房费账目）：连住合并/分段计价后 ≠ 单价 × 晚数 */}
                    <td className="num" data-label="房费">{fmtMoney(r.room_charge_total ?? (r.stay_type === 'hourly' ? r.rate * r.hours : r.rate * r.nights))}</td>
                    <td data-label="来源">
                      {r.channel_name && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ width: 8, height: 8, borderRadius: 2.5, background: r.channel_color ?? '#86868b', display: 'inline-block' }} />
                          {r.channel_name}
                        </span>
                      )}
                    </td>
                    <td data-label="状态">
                      <span className={`badge ${RES_STATUS_BADGE[r.status]?.color}`}>
                        {RES_STATUS_BADGE[r.status]?.label}{r.status === 'checked_in' && r.room_number ? ` · ${r.room_number}` : ''}
                      </span>
                    </td>
                    <td data-label="操作人">{r.operator_name ?? '—'}</td>
                    <td className="no-label">
                      {(r.status === 'pending' || r.status === 'confirmed') && (
                        <button className="btn btn-quiet btn-sm" onClick={() => setPayRes(r)}>收款</button>
                      )}
                      {(r.status === 'pending' || r.status === 'confirmed') && (
                        <button className="btn btn-quiet btn-sm" onClick={() => setEditRes(r)}>编辑</button>
                      )}
                      {r.status === 'pending' && (
                        <button className="btn btn-quiet btn-sm" onClick={() => mut.mutate({ path: `/api/reservations/${r.id}/confirm`, label: '预订已确认' })}>确认</button>
                      )}
                      {(r.status === 'pending' || r.status === 'confirmed') && (
                        <button className="btn btn-danger-ghost btn-sm" onClick={() => setCancelRes(r)}>取消</button>
                      )}
                      {/* 预收款徽章（pending/confirmed）：提前收款（押金/预付款）后亮已收金额，与在住/已退的「欠」对位 */}
                      {(r.status === 'pending' || r.status === 'confirmed') && (r.paid_total ?? 0) > 0 && (
                        <span className="badge badge-green" style={{ marginRight: 6 }}>已收 {fmtMoney(r.paid_total ?? 0)}</span>
                      )}
                      {(r.status === 'checked_in' || r.status === 'checked_out') && r.balance_due > 0 && <span className="badge badge-red" style={{ marginRight: 6 }}>欠 {fmtMoney(r.balance_due)}</span>}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 32 }}>暂无符合条件的预订</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 取消预订确认（应用内弹层替代 window.confirm；有已收款时亮金额——取消将清除全部款项） */}
      {cancelRes && (
        <ConfirmDialog open onClose={() => setCancelRes(null)} busy={mut.isPending}
          title="取消预订" sub={`${cancelRes.guest_name} · ${cancelRes.code}`} confirmText="确认取消"
          onConfirm={() => { setCancelRes(null); mut.mutate({ path: `/api/reservations/${cancelRes.id}/cancel`, label: '预订已取消' }) }}>
          <p className="confirm-msg">确定取消该预订吗？</p>
          {(cancelRes.paid_total ?? 0) > 0 && (
            <div className="info-row"><span>已收款</span><span>{fmtMoney(cancelRes.paid_total ?? 0)}</span></div>
          )}
          <div className="danger-note">取消会清除该预订已收取的款项（不生成退款凭证），且不可恢复。</div>
        </ConfirmDialog>
      )}

      {/* 收款（预订阶段提前收款：押金 / 订金 / 预付全款；与房态盘订单详情共用 AddPaymentDialog） */}
      {payRes && (
        <AddPaymentDialog
          res={payRes} busy={payMut.isPending}
          onClose={() => setPayRes(null)}
          onSubmit={({ method, amount, remark }) => payMut.mutate({ id: payRes.id, body: { method, amount, remark } })}
        />
      )}

      {/* 编辑预订（待确认 / 已确认；与房态盘详情抽屉共用弹层） */}
      {editRes && (
        <EditBookingDialog
          res={editRes} channels={channels.data ?? []} busy={editMut.isPending}
          onClose={() => setEditRes(null)}
          onConfirm={(body) => editMut.mutate({ id: editRes.id, body })}
        />
      )}

      <NewReservationDialog
        open={newOpen} onClose={() => setNewOpen(false)}
        channels={channels.data ?? []} types={types.data ?? []}
        onSubmit={(body) => mut.mutate({
          path: '/api/reservations', body, method: 'post',
          label: `预订已创建：${body.guest_name}`,
        })}
        onDone={() => setNewOpen(false)}
        creating={mut.isPending}
      />
    </>
  )
}

function NewReservationDialog({ open, onClose, channels, types, onSubmit, onDone, creating }: {
  open: boolean
  onClose: () => void
  channels: Channel[]
  types: RoomType[]
  onSubmit: (body: any) => void
  onDone: () => void
  creating: boolean
}) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [typeId, setTypeId] = useState<number | null>(null)
  const [cin, setCin] = useState(todayIso())
  const [cout, setCout] = useState(addDaysIso(todayIso(), 1))
  const [nightsText, setNightsText] = useState('1')
  const [channelId, setChannelId] = useState<number | null>(null)
  const [notes, setNotes] = useState('')
  /** 整晚 / 钟点（所选房型支持钟点时可选） */
  const [stayType, setStayType] = useState<'normal' | 'hourly'>('normal')
  /** 钟点时长默认 3 小时 */
  const [hours, setHours] = useState(3)
  /** 协议总价（整单）：单价由总额按天数折算后提交 */
  const [totalText, setTotalText] = useState('')
  /** 预收款（选填）：创建时同步收押金/订金/预付款，金额 > 0 才提交（含方式与款项备注） */
  const [depositText, setDepositText] = useState('')
  const [depositMethod, setDepositMethod] = useState('cash')
  const [depositRemark, setDepositRemark] = useState('代收押金')
  const payMethods = usePayMethods()

  const type = types.find(t => t.id === typeId)
  const nights = Math.max(1, Math.round(Number(nightsText) || 1))
  /** 所选房型的钟点档位（空数组 = 不支持钟点房） */
  const tiers = type?.hourly_rates ?? []
  const hourlyAvail = tiers.length > 0
  /** 用户是否手改过总额：未改时总额跟随「房型基准价 × 数量」 */
  const [totalTouched, setTotalTouched] = useState(false)

  useEffect(() => {
    if (open) {
      setName(''); setPhone(''); setChannelId(null); setNotes(''); setStayType('normal'); setHours(3)
      setCin(todayIso()); setCout(addDaysIso(todayIso(), 1))
      setNightsText('1'); setTotalText(''); setTotalTouched(false)
      setDepositText(''); setDepositMethod('cash'); setDepositRemark('代收押金')
    }
  }, [open])

  // 收款方式默认值同步进 state（沿用来源下拉坑规则：显示即选中的下拉不能只靠渲染兜底）
  useEffect(() => {
    if (!open) return
    const codes = (payMethods.data ?? []).map(m => m.code)
    setDepositMethod(prev => (codes.length && !codes.includes(prev) ? codes[0] : prev))
  }, [open, payMethods.data])

  // 来源下拉没有「未指定」项：默认选中第一个渠道并同步到状态，
  // 否则界面显示美团、提交 channel_id=null（列表来源列空白、方块竖条落灰色默认值）
  useEffect(() => {
    if (!open) return
    setChannelId(prev => (prev === null ? (channels[0]?.id ?? null) : prev))
  }, [open, channels])

  // 房型 / 天数变化时按基准价带出总价（用户未手改前保持跟随）：
  // 钟点 = 该时长的档位整单总价（未命中档位回落最大档折合单价 × h）；整晚 = 基准价 × 晚数
  useEffect(() => {
    if (!totalTouched && type) {
      if (stayType === 'hourly') {
        const tier = tiers.find(t => t.hours === hours)
        const ref = tiers.length ? tiers[tiers.length - 1] : null
        const totalH = tier ? tier.price : (ref ? round2((ref.price / ref.hours) * hours) : 0)
        setTotalText(String(round2(totalH)))
      } else {
        setTotalText(String(round2(type.base_price * nights)))
      }
    }
  }, [type, nights, hours, stayType, totalTouched])

  const units = stayType === 'hourly' ? hours : nights
  const unitLabel = stayType === 'hourly' ? '小时' : '晚'
  const total = Math.max(0, round2(Number(totalText) || 0))
  const unitPrice = units > 0 ? round2(total / units) : 0
  const finalTotal = round2(unitPrice * units)
  /** 预收款金额：> 0 才随创建提交 */
  const deposit = round2(Number(depositText) || 0)

  /** 改天数：离店日与总额（按折合单价）一起重算 */
  const onNightsChange = (v: string) => {
    const digits = v.replace(/[^\d]/g, '')
    setNightsText(digits)
    const n = Math.max(1, Math.round(Number(digits) || 1))
    setCout(addDaysIso(cin, n))
    const u = (units > 0 ? round2(total / units) : 0) || (type?.base_price ?? 0)
    setTotalText(String(round2(n * u)))
    setTotalTouched(true)
  }
  /** 改离店日期：反推天数；若所选离店日不晚于入住日，自动将入住日回推 1 天 */
  const onCoutChange = (value: string) => {
    setCout(value)
    const diff = diffDaysIso(cin, value)
    if (diff < 1) {
      setCin(shiftIso(value, -1))
    }
    const n = Math.max(1, diff)
    setNightsText(String(n))
    const u = (units > 0 ? round2(total / units) : 0) || (type?.base_price ?? 0)
    setTotalText(String(round2(n * u)))
    setTotalTouched(true)
  }

  const datePicker = useDateRangePicker({
    start: cin,
    end: cout,
    onStartChange: (v, keepEnd) => {
      setCin(v)
      if (keepEnd) {
        const n = Math.max(1, diffDaysIso(v, cout))
        setNightsText(String(n))
        const u = (units > 0 ? round2(total / units) : 0) || (type?.base_price ?? 0)
        setTotalText(String(round2(n * u)))
        setTotalTouched(true)
      } else {
        setCout(addDaysIso(v, nights))
      }
    },
    onEndChange: onCoutChange,
    allowSameDay: false,
    endDisabled: stayType === 'hourly',
    startLabel: '入住日期',
    endLabel: '离店日期',
  })

  useEffect(() => {
    if (!open) datePicker.close()
  }, [open, datePicker.close])

  const submit = () => {
    if (!name.trim()) { toast('请输入客人姓名'); return }
    if (nights <= 0) { toast('离店日期必须晚于入住日期'); return }
    onSubmit({
      guest_name: name, guest_phone: phone, guest_id_number: '',
      check_in: cin, check_out: stayType === 'hourly' ? addDaysIso(cin, 1) : cout,
      room_type_id: typeId,
      channel_id: channelId, notes,
      stay_type: stayType, hours: stayType === 'hourly' ? hours : 0,
      rate: unitPrice,
      status: 'confirmed',
      // 预收款：金额 > 0 才提交（后端 amount<=0 视为未填，双保险）
      ...(deposit > 0 ? {
        deposit_amount: deposit, deposit_method: depositMethod,
        deposit_remark: depositRemark.trim(),
      } : {}),
    })
    onDone()
  }

  return (
    <Dialog
      open={open} onClose={onClose} wide title="新建预订"
      foot={
        <>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={submit} disabled={creating}>确认创建</button>
        </>
      }
    >
      <div className="form-row">
        <Field label="客人姓名" required>
          <GuestNameInput value={name} onChange={setName} onPick={g => { setName(g.name); setPhone(g.phone || '') }} />
        </Field>
        <Field label="手机号（选填）">
          <input className="input" value={phone} onChange={e => setPhone(e.target.value)} placeholder="可留空，到店时补录" />
        </Field>
      </div>
      <Field label="房型" required>
        <select className="select" value={typeId ?? ''} onChange={e => {
          const id = Number(e.target.value)
          setTypeId(id)
          // 新房型未配置钟点档位时退出钟点模式：分段控件随之隐藏，避免 stayType 残留提交出钟点单
          const t = types.find(x => x.id === id)
          if (!t || !(t.hourly_rates ?? []).length) setStayType('normal')
        }}>
          <option value="">请选择房型</option>
          {types.map(t => <option key={t.id} value={t.id}>{t.name} · {fmtMoney(t.base_price)}/晚 · {t.room_count} 间</option>)}
        </select>
      </Field>
      {hourlyAvail && (
        <Field label="入住方式">
          <div className="segmented">
            <button className={stayType === 'normal' ? 'active' : ''} onClick={() => setStayType('normal')}>整晚</button>
            <button className={stayType === 'hourly' ? 'active' : ''} onClick={() => {
              setStayType('hourly')
              // 所选房型没有 3 小时档时回落首档（与房态盘 BookDrawer 同口径）
              if (!(tiers.some(t => t.hours === hours)) && tiers.length) setHours(tiers[0].hours)
            }}>钟点</button>
          </div>
        </Field>
      )}
      {hourlyAvail && stayType === 'hourly' && (
        <Field label="入住时长">
          <div className="chips">
            {tiers.map(t => (
              <button key={t.hours} className={`chip${hours === t.hours ? ' active' : ''}`} onClick={() => setHours(t.hours)}>{t.hours} 小时 <span className="n">{fmtMoney(t.price)}</span></button>
            ))}
          </div>
        </Field>
      )}
      <div className="form-row">
        <Field label="入住日期" required>
          <DateRangeInput ctrl={datePicker} side="start" />
        </Field>
        <Field label="入住天数" required>
          <input className="input" inputMode="numeric" value={nightsText} onChange={e => onNightsChange(e.target.value)} />
        </Field>
      </div>
      <div className="form-row">
        <Field label="离店日期" required>
          <DateRangeInput ctrl={datePicker} side="end" />
        </Field>
        <Field
          label="协议总价（整单，元）"
          hint={type ? `折合 ${fmtMoney(unitPrice)}/${unitLabel}（${units} ${unitLabel}）· 最终应收 ${fmtMoney(finalTotal)}；改天数时按折合单价自动重算。` : '请先选择房型。'}
        >
          <input
            className="input" inputMode="decimal" value={totalText} placeholder="0"
            onChange={e => { setTotalText(moneyInputText(e.target.value)); setTotalTouched(true) }}
          />
        </Field>
      </div>
      <DateRangePopover ctrl={datePicker} />
      <p className="hint">
        {stayType === 'hourly' && hourlyAvail
          ? `钟点房费 ${fmtMoney(finalTotal)}（${hours} 小时 × ${fmtMoney(unitPrice)}）`
          : type ? `共 ${nights} 晚 · 折合 ${fmtMoney(unitPrice)}/晚 · 应收 ${fmtMoney(finalTotal)}` : '请选择房型与日期。'}
      </p>
      <div className="form-row mt-16">
        <Field label="来源">
          <select className="select" value={channelId ?? ''} onChange={e => setChannelId(e.target.value ? Number(e.target.value) : null)}>
            {channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="备注">
          <input className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="如：高楼层、无烟房" />
        </Field>
      </div>
      {/* 预收款（选填）：预订阶段直接收押金/订金/预付款，创建时一并入账 */}
      <Field
        label="预收款（选填，元）"
        hint="预订阶段可提前收款（押金 / 订金 / 预付全款），创建时一并入账。"
      >
        <input
          className="input" inputMode="decimal" value={depositText}
          placeholder="如：500（押金）· 留空则到店结清"
          onChange={e => setDepositText(moneyInputText(e.target.value))}
        />
      </Field>
      {deposit > 0 && (
        <div className="form-row">
          <Field label="收款方式">
            <select className="select" value={depositMethod} onChange={e => setDepositMethod(e.target.value)}>
              {(payMethods.data ?? []).map(m => <option key={m.code} value={m.code}>{m.name}</option>)}
            </select>
          </Field>
          <Field label="款项备注">
            <input className="input" value={depositRemark} maxLength={120} onChange={e => setDepositRemark(e.target.value)} placeholder="如：代收押金、订金、预付全款" />
          </Field>
        </div>
      )}
      {deposit > 0 && (
        <p className="hint">
          {stayType === 'hourly' && hourlyAvail
            ? `创建后入账 ${fmtMoney(deposit)} · 钟点房费 ${fmtMoney(finalTotal)} · 余款到店结清`
            : `创建后入账 ${fmtMoney(deposit)} · 应收 ${fmtMoney(finalTotal)} · 余款 ${fmtMoney(Math.max(0, round2(finalTotal - deposit)))} 到店结清`}
        </p>
      )}
    </Dialog>
  )
}
