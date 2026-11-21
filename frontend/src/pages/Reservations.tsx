import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'react-router-dom'
import {
  api, addDaysIso, fmtMoney, maskPhone, md, todayIso, RES_STATUS_LABEL,
  type Channel, type Reservation, type RoomType,
} from '../api'
import { Dialog, Field, PageHead, Segmented, Spinner, useToast, RES_STATUS_BADGE } from '../ui'
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
    onSuccess: (_d, p) => { if (p.label) toast(p.label); qc.invalidateQueries({ queryKey: ['reservations'] }) },
    onError: (e: any) => toast(e.message ?? '操作失败'),
  })

  const rows = list.data ?? []
  const counts: Record<string, number> = {}
  // 全量计数（不含筛选）：轻量做法——仅在 all 页统计
  if (status === 'all') {
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1
  }

  return (
    <>
      <PageHead
        title="预订管理"
        desc={`共 ${rows.length} 条预订 · 操作留痕可追溯`}
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
                    <td className="num" data-label="房费">{fmtMoney(r.stay_type === 'hourly' ? r.rate * r.hours : r.rate * r.nights)}</td>
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
                      {r.status === 'pending' && (
                        <>
                          <button className="btn btn-quiet btn-sm" onClick={() => mut.mutate({ path: `/api/reservations/${r.id}/confirm`, label: '预订已确认' })}>确认</button>
                          <button className="btn btn-danger-ghost btn-sm" onClick={() => { if (window.confirm('确定取消该预订吗？')) mut.mutate({ path: `/api/reservations/${r.id}/cancel`, label: '预订已取消' }) }}>取消</button>
                        </>
                      )}
                      {r.status === 'confirmed' && (
                        <button className="btn btn-quiet btn-sm" onClick={() => { if (window.confirm('确定取消该预订吗？')) mut.mutate({ path: `/api/reservations/${r.id}/cancel`, label: '预订已取消' }) }}>取消</button>
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
  const [hours, setHours] = useState(4)
  /** 协议总价（整单）：单价由总额按天数折算后提交 */
  const [totalText, setTotalText] = useState('')

  const type = types.find(t => t.id === typeId)
  const nights = Math.max(1, Math.round(Number(nightsText) || 1))
  const hourlyAvail = (type?.hourly_price ?? 0) > 0
  /** 用户是否手改过总额：未改时总额跟随「房型基准价 × 数量」 */
  const [totalTouched, setTotalTouched] = useState(false)

  useEffect(() => {
    if (open) {
      setName(''); setPhone(''); setChannelId(null); setNotes(''); setStayType('normal'); setHours(4)
      setCin(todayIso()); setCout(addDaysIso(todayIso(), 1))
      setNightsText('1'); setTotalText(''); setTotalTouched(false)
    }
  }, [open])

  // 来源下拉没有「未指定」项：默认选中第一个渠道并同步到状态，
  // 否则界面显示美团、提交 channel_id=null（列表来源列空白、方块竖条落灰色默认值）
  useEffect(() => {
    if (!open) return
    setChannelId(prev => (prev === null ? (channels[0]?.id ?? null) : prev))
  }, [open, channels])

  // 房型 / 天数变化时按基准价带出总价（用户未手改前保持跟随）
  useEffect(() => {
    if (!totalTouched && type) {
      setTotalText(String((stayType === 'hourly' ? (type.hourly_price || 0) * hours : type.base_price * nights)))
    }
  }, [type, nights, hours, stayType, totalTouched])

  const units = stayType === 'hourly' ? hours : nights
  const unitLabel = stayType === 'hourly' ? '小时' : '晚'
  const total = Math.max(0, Math.round(Number(totalText) || 0))
  const unitPrice = units > 0 ? Math.round(total / units) : 0
  const finalTotal = unitPrice * units

  /** 改天数：离店日与总额（按折合单价）一起重算 */
  const onNightsChange = (v: string) => {
    const digits = v.replace(/[^\d]/g, '')
    setNightsText(digits)
    const n = Math.max(1, Math.round(Number(digits) || 1))
    setCout(addDaysIso(cin, n))
    const u = (units > 0 ? Math.round(total / units) : 0) || (type?.base_price ?? 0)
    setTotalText(String(n * u))
    setTotalTouched(true)
  }
  /** 改离店日期：反推天数 */
  const onCoutChange = (value: string) => {
    setCout(value)
    const n = Math.max(1, Math.round((new Date(value).getTime() - new Date(cin).getTime()) / 86400000) || 1)
    setNightsText(String(n))
    const u = (units > 0 ? Math.round(total / units) : 0) || (type?.base_price ?? 0)
    setTotalText(String(n * u))
    setTotalTouched(true)
  }

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
    })
    onDone()
  }

  return (
    <Dialog
      open={open} onClose={onClose} wide title="新建预订"
      foot={
        <>
          <span className="hint" style={{ marginRight: 'auto' }}>操作人：当前登录账号 · 创建后将记录到预订日志</span>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={submit} disabled={creating}>确认创建</button>
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
      <Field label="房型" required>
        <select className="select" value={typeId ?? ''} onChange={e => {
          const id = Number(e.target.value)
          setTypeId(id)
          // 新房型未配置钟点价时退出钟点模式：分段控件随之隐藏，避免 stayType 残留提交出钟点单
          const t = types.find(x => x.id === id)
          if (!t || !(t.hourly_price > 0)) setStayType('normal')
        }}>
          <option value="">请选择房型</option>
          {types.map(t => <option key={t.id} value={t.id}>{t.name} · ¥{t.base_price}/晚 · {t.room_count} 间</option>)}
        </select>
      </Field>
      {hourlyAvail && (
        <Field label="入住方式">
          <div className="segmented">
            <button className={stayType === 'normal' ? 'active' : ''} onClick={() => setStayType('normal')}>整晚</button>
            <button className={stayType === 'hourly' ? 'active' : ''} onClick={() => setStayType('hourly')}>钟点</button>
          </div>
          <span className="hint">钟点价 ¥{type!.hourly_price}/小时；钟点房按入住日占整日，时长 {hours} 小时。</span>
        </Field>
      )}
      {hourlyAvail && stayType === 'hourly' && (
        <Field label="入住时长">
          <div className="chips">
            {[2, 3, 4, 6, 8].map(x => (
              <button key={x} className={`chip${hours === x ? ' active' : ''}`} onClick={() => setHours(x)}>{x} 小时</button>
            ))}
          </div>
        </Field>
      )}
      <div className="form-row">
        <Field label="入住日期" required hint="默认为今天，可修改。">
          <input className="input" type="date" value={cin} onChange={e => { setCin(e.target.value); setCout(addDaysIso(e.target.value, nights)) }} />
        </Field>
        <Field label="入住天数" required hint="改天数后离店日期自动重算；也可直接改离店日期。">
          <input className="input" inputMode="numeric" value={nightsText} onChange={e => onNightsChange(e.target.value)} />
        </Field>
      </div>
      <div className="form-row">
        <Field label="离店日期" required>
          <input className="input" type="date" value={cout} onChange={e => onCoutChange(e.target.value)} disabled={stayType === 'hourly'} />
        </Field>
        <Field
          label="协议总价（整单，元）"
          hint={type ? `折合 ¥${unitPrice}/${unitLabel}（${units} ${unitLabel}）· 最终应收 ¥${finalTotal.toLocaleString()}；改天数时按折合单价自动重算。` : '请先选择房型。'}
        >
          <input
            className="input" inputMode="numeric" value={totalText} placeholder="0"
            onChange={e => { setTotalText(e.target.value.replace(/[^\d]/g, '')); setTotalTouched(true) }}
          />
        </Field>
      </div>
      <p className="hint">
        {stayType === 'hourly' && hourlyAvail
          ? `钟点房费 ¥${finalTotal.toLocaleString()}（${hours} 小时 × ¥${unitPrice}）· 按入住日占用整天，创建后将自动预留空净房。`
          : type ? `共 ${nights} 晚 · 折合 ¥${unitPrice}/晚 · 应收 ¥${finalTotal.toLocaleString()} · 预订后将自动预留空净房，入住时可改派。` : '请选择房型与日期。'}
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
    </Dialog>
  )
}
