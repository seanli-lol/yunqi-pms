import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { api, fmtMoney, maskPhone, round2, type Channel, type Hotel, type PayMethod, type Room, type RoomType, type UserRow } from '../api'
import { useAuth } from '../auth'
import { Badge, ConfirmDialog, Dialog, Field, PageHead, Segmented, Spinner, useToast } from '../ui'

type Tab = 'hotels' | 'channels' | 'paymethods' | 'types' | 'rooms' | 'staff'

export default function Settings() {
  const toast = useToast()
  const qc = useQueryClient()
  const { user, activeHotelId, activeHotelName, setActiveHotel } = useAuth()
  const [tab, setTab] = useState<Tab>('hotels')

  const hotels = useQuery({ queryKey: ['hotels'], queryFn: () => api.get<Hotel[]>('/api/hotels') })
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<UserRow[]>('/api/users') })

  // 谁能看到切店下拉：超级管理员恒可；员工绑定 ≥2 家酒店（与顶栏同口径）
  const canSwitch = user?.role === 'platform_admin' || (user?.hotel_ids?.length ?? 0) > 1

  // 超级管理员首次进入：自动选中第一家酒店作为业务上下文
  useEffect(() => {
    if (user?.role === 'platform_admin' && !activeHotelId && hotels.data?.length) {
      setActiveHotel(hotels.data[0].id, hotels.data[0].name)
    }
  }, [user, activeHotelId, hotels.data, setActiveHotel])

  return (
    <>
      <PageHead
        title="系统设置"
        desc="酒店（多店隔离）、来源渠道、收款方式、房型、客房与员工账号"
      />

      {canSwitch && (
        <div className="card card-pad mb-24" style={{ padding: '14px 24px' }}>
          <div className="flex-between">
            <span className="hint" style={{ fontSize: 13 }}>
              {user?.role === 'platform_admin'
                ? '超级管理员视角：请先选择要管理的酒店，下方各业务 Tab 的数据将随所选酒店切换。'
                : '多店账号：请选择要管理的酒店，下方各业务 Tab 的数据将随所选酒店切换。'}
            </span>
            <select
              className="select" style={{ width: 240, height: 38 }}
              value={activeHotelId ?? ''}
              onChange={e => {
                const id = Number(e.target.value)
                const h = hotels.data?.find(x => x.id === id)
                if (h) setActiveHotel(h.id, h.name)
              }}
            >
              {(hotels.data ?? []).map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </div>
        </div>
      )}

      <div className="filter-bar">
        <Segmented
          value={tab}
          options={[
            { key: 'hotels', label: '酒店管理' },
            { key: 'channels', label: '来源渠道' },
            { key: 'paymethods', label: '收款方式' },
            { key: 'types', label: '房型管理' },
            { key: 'rooms', label: '客房管理' },
            { key: 'staff', label: '员工账号' },
          ]}
          onChange={setTab}
        />
      </div>

      {tab === 'hotels' && <HotelsTab data={hotels.data} loading={hotels.isLoading} isAdmin={user?.role === 'platform_admin'} />}
      {tab === 'channels' && <ChannelsTab />}
      {tab === 'paymethods' && <PayMethodsTab />}
      {tab === 'types' && <TypesTab />}
      {tab === 'rooms' && <RoomsTab />}
      {tab === 'staff' && <StaffTab users={users.data} loading={users.isLoading} />}
    </>
  )
}

/* ==================== 酒店管理 ==================== */
function HotelsTab({ data, loading, isAdmin }: { data?: Hotel[]; loading: boolean; isAdmin: boolean }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)
  const [editHotel, setEditHotel] = useState<Hotel | null>(null)
  const mut = useMutation({
    mutationFn: (body: any) => api.post('/api/hotels', body),
    onSuccess: () => { toast('酒店已创建，数据将完全隔离'); setAddOpen(false); qc.invalidateQueries({ queryKey: ['hotels'] }) },
    onError: (e: any) => toast(e.message ?? '创建失败'),
  })
  // ['hotels'] 与 AppShell 平台管理员切店下拉共用缓存，改名/停用后自动跟着刷新
  const editMut = useMutation({
    mutationFn: (p: { id: number; body: Record<string, unknown> }) => api.patch(`/api/hotels/${p.id}`, p.body),
    onSuccess: () => { toast('酒店信息已更新'); setEditHotel(null); qc.invalidateQueries({ queryKey: ['hotels'] }) },
    onError: (e: any) => toast(e.message ?? '保存失败'),
  })

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div className="section-sub" style={{ fontSize: 13.5 }}>
            共 {data?.length ?? 0} 家酒店 · 各店数据完全隔离（房态、预订、账务、报表互不可见）
          </div>
          {isAdmin && <button className="btn btn-primary btn-sm" onClick={() => setAddOpen(true)}>添加酒店</button>}
        </div>
        {loading ? <Spinner /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>酒店</th><th>城市 / 地址</th><th className="num">客房数</th><th className="num">员工</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>
                {(data ?? []).map(h => (
                  <tr key={h.id}>
                    <td data-label="酒店" className="strong">{h.name}</td>
                    <td data-label="城市 / 地址">{h.city} · {h.address}</td>
                    <td className="num" data-label="客房数">{h.room_count}</td>
                    <td className="num" data-label="员工">{h.staff_count}</td>
                    <td data-label="状态">{h.is_active ? <Badge color="green">营业中</Badge> : <Badge color="orange">筹备中</Badge>}</td>
                    <td className="no-label">
                      {isAdmin && <button className="btn btn-quiet btn-sm" onClick={() => setEditHotel(h)}>编辑</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="hint mt-16">
        {isAdmin
          ? '仅超级管理员可添加酒店；每家酒店拥有独立的房态、预订、账务与报表数据，互不干扰。'
          : '您管理的酒店数据与其他门店完全隔离。'}
      </p>

      <AddHotelDialog open={addOpen} onClose={() => setAddOpen(false)} onSubmit={(b) => mut.mutate(b)} busy={mut.isPending} />
      <EditHotelDialog
        hotel={editHotel} busy={editMut.isPending}
        onClose={() => setEditHotel(null)}
        onSubmit={(b) => editHotel && editMut.mutate({ id: editHotel.id, body: b })}
      />
    </>
  )
}

function AddHotelDialog({ open, onClose, onSubmit, busy }: {
  open: boolean; onClose: () => void; onSubmit: (b: any) => void; busy: boolean
}) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [city, setCity] = useState('')
  const [addr, setAddr] = useState('')
  const [contact, setContact] = useState('')
  useEffect(() => { if (open) { setName(''); setCity(''); setAddr(''); setContact('') } }, [open])
  return (
    <Dialog
      open={open} onClose={onClose} title="添加酒店"
      foot={
        <>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary" disabled={busy || !name.trim()}
            onClick={() => {
              if (!name.trim()) { toast('请输入酒店名称'); return }
              onSubmit({ name, city, address: addr, contact_name: contact })
            }}
          >创建酒店</button>
        </>
      }
    >
      <Field label="酒店名称" required><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="如：云栖酒店 · 千岛湖店" /></Field>
      <div className="form-row">
        <Field label="城市" required><input className="input" value={city} onChange={e => setCity(e.target.value)} placeholder="如：杭州" /></Field>
        <Field label="店长姓名"><input className="input" value={contact} onChange={e => setContact(e.target.value)} placeholder="创建首个管理员账号时使用" /></Field>
      </div>
      <Field label="地址"><input className="input" value={addr} onChange={e => setAddr(e.target.value)} /></Field>
      <p className="hint">创建后可在「员工账号」中为该酒店添加员工；新酒店默认为空，房型与客房需单独配置。</p>
    </Dialog>
  )
}

function EditHotelDialog({ hotel, onClose, onSubmit, busy }: {
  hotel: Hotel | null; onClose: () => void; onSubmit: (b: Record<string, unknown>) => void; busy: boolean
}) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [city, setCity] = useState('')
  const [addr, setAddr] = useState('')
  const [contact, setContact] = useState('')
  const [active, setActive] = useState(true)
  useEffect(() => {
    if (hotel) {
      setName(hotel.name); setCity(hotel.city); setAddr(hotel.address)
      setContact(hotel.contact_name); setActive(hotel.is_active)
    }
  }, [hotel])
  return (
    <Dialog
      open={!!hotel} onClose={onClose} title="编辑酒店信息"
      foot={
        <>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary" disabled={busy || !name.trim()}
            onClick={() => {
              if (!name.trim()) { toast('请输入酒店名称'); return }
              onSubmit({ name, city, address: addr, contact_name: contact, is_active: active })
            }}
          >保存修改</button>
        </>
      }
    >
      <Field label="酒店名称" required><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="如：云栖酒店 · 千岛湖店" /></Field>
      <div className="form-row">
        <Field label="城市"><input className="input" value={city} onChange={e => setCity(e.target.value)} placeholder="如：杭州" /></Field>
        <Field label="店长姓名"><input className="input" value={contact} onChange={e => setContact(e.target.value)} /></Field>
      </div>
      <Field label="地址"><input className="input" value={addr} onChange={e => setAddr(e.target.value)} /></Field>
      <Field label="状态" hint="筹备中的酒店不出现在登录页选择列表，已登录会话不受影响。">
        <Segmented
          value={active ? 'on' : 'off'}
          options={[{ key: 'on', label: '营业中' }, { key: 'off', label: '筹备中' }]}
          onChange={v => setActive(v === 'on')}
        />
      </Field>
    </Dialog>
  )
}

/* ==================== 来源渠道 ==================== */
function ChannelsTab() {
  const toast = useToast()
  const qc = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)
  const list = useQuery({ queryKey: ['channels-all'], queryFn: () => api.get<Channel[]>('/api/channels?include_inactive=true') })
  const mut = useMutation({
    mutationFn: (p: { method: string; path: string; body?: any }) =>
      p.method === 'post' ? api.post(p.path, p.body) : api.patch(p.path, p.body),
    onSuccess: () => {
      toast('渠道配置已更新')
      qc.invalidateQueries({ queryKey: ['channels'] })
      qc.invalidateQueries({ queryKey: ['channels-all'] })
    },
    onError: (e: any) => toast(e.message ?? '操作失败'),
  })

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div className="section-sub" style={{ fontSize: 13.5 }}>
            预订来源的颜色与展示顺序 · 顺序决定下拉选项与房态盘图例排列
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => setAddOpen(true)}>添加渠道</button>
        </div>
        {list.isLoading ? <Spinner /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th style={{ width: 64 }}>顺序</th><th>渠道</th><th>颜色</th><th className="num">状态</th><th>操作</th></tr></thead>
              <tbody>
                {(list.data ?? []).map((c, i) => (
                  <tr key={c.id}>
                    <td data-label="顺序">
                      <div style={{ display: 'flex', gap: 4 }}>
                        {i > 0 && (
                          <button className="icon-btn" title="上移"
                                  onClick={async () => {
                                    const prev = list.data![i - 1]
                                    try {
                                      await api.patch(`/api/channels/${c.id}`, { sort_order: prev.sort_order })
                                      await api.patch(`/api/channels/${prev.id}`, { sort_order: c.sort_order })
                                      toast('顺序已调整')
                                      qc.invalidateQueries({ queryKey: ['channels'] })
                                      qc.invalidateQueries({ queryKey: ['channels-all'] })
                                    } catch (e: any) { toast(e.message ?? '操作失败') }
                                  }}>
                            ↑
                          </button>
                        )}
                        <span className="hint" style={{ alignSelf: 'center' }}>{i + 1}</span>
                      </div>
                    </td>
                    <td data-label="渠道" className="strong">{c.name}</td>
                    <td data-label="颜色">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                          type="color" value={c.color}
                          onChange={e => mut.mutate({ method: 'patch', path: `/api/channels/${c.id}`, body: { color: e.target.value } })}
                          style={{ width: 34, height: 30, border: '1px solid var(--hairline-soft)', borderRadius: 8, padding: 2, background: '#fff', cursor: 'pointer' }}
                        />
                        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{c.color}</span>
                      </div>
                    </td>
                    <td className="num" data-label="状态">{c.is_active ? <Badge color="green">启用</Badge> : <Badge color="gray">停用</Badge>}</td>
                    <td className="no-label">
                      <button
                        className="btn btn-quiet btn-sm"
                        onClick={() => mut.mutate({ method: 'patch', path: `/api/channels/${c.id}`, body: { is_active: !c.is_active } })}
                      >{c.is_active ? '停用' : '启用'}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card card-pad mt-16">
        <div className="section-title" style={{ marginBottom: 10 }}>效果预览</div>
        <div className="flex-between" style={{ gap: 8 }}>
          {(list.data ?? []).slice(0, 4).map(c => (
            <div
              key={c.id}
              className="cal-block stay"
              style={{ position: 'relative', height: 42, flex: 1, minWidth: 150, ['--src' as any]: c.color }}
            >
              <span className="g">住客示例</span>
              <span className="s">{c.name}</span>
            </div>
          ))}
        </div>
        <p className="hint mt-8">调整颜色或顺序后，房态盘日历、预订列表与下拉选项实时生效。</p>
      </div>

      <AddChannelDialog open={addOpen} onClose={() => setAddOpen(false)} onSubmit={(b) => mut.mutate({ method: 'post', path: '/api/channels', body: b })} />
    </>
  )
}

function AddChannelDialog({ open, onClose, onSubmit }: {
  open: boolean; onClose: () => void; onSubmit: (b: any) => void
}) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [color, setColor] = useState('#FF9500')
  useEffect(() => { if (open) { setName(''); setColor('#FF9500') } }, [open])
  return (
    <Dialog
      open={open} onClose={onClose} title="添加渠道"
      foot={
        <>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary" disabled={!name.trim()}
            onClick={() => {
              if (!name.trim()) { toast('请输入渠道名称'); return }
              onSubmit({ name, color })
              onClose()
            }}
          >创建渠道</button>
        </>
      }
    >
      <Field label="渠道名称" required><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="如：抖音团购" /></Field>
      <Field label="颜色" required hint="颜色将用于预订方块最前端的来源竖条与图例。">
        <input className="input" type="color" value={color} onChange={e => setColor(e.target.value)} style={{ height: 44, padding: 6, cursor: 'pointer' }} />
      </Field>
    </Dialog>
  )
}

/* ==================== 收款方式 ==================== */
function PayMethodsTab() {
  const toast = useToast()
  const qc = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)
  const [editing, setEditing] = useState<PayMethod | null>(null)
  const list = useQuery({ queryKey: ['pay-methods-all'], queryFn: () => api.get<PayMethod[]>('/api/payment-methods?include_inactive=true') })
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['pay-methods'] })
    qc.invalidateQueries({ queryKey: ['pay-methods-all'] })
  }
  const mut = useMutation({
    mutationFn: (p: { method: string; path: string; body?: any }) =>
      p.method === 'post' ? api.post(p.path, p.body) : api.patch(p.path, p.body),
    onSuccess: () => {
      toast('收款方式已更新')
      invalidate()
    },
    onError: (e: any) => toast(e.message ?? '操作失败'),
  })
  const del = useMutation({
    mutationFn: (id: number) => api.delete<{ ok: boolean; disabled?: boolean }>(`/api/payment-methods/${id}`),
    onSuccess: (d) => {
      toast(d?.disabled ? '该方式有收款记录，已改为停用' : '收款方式已删除')
      invalidate()
    },
    onError: (e: any) => toast(e.message ?? '操作失败'),
  })
  const actives = (list.data ?? []).filter(m => m.is_active)

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div className="section-sub" style={{ fontSize: 13.5 }}>
            前台收款与入住登记的收款方式选项 · 顺序决定下拉选项排列
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => setAddOpen(true)}>添加方式</button>
        </div>
        {list.isLoading ? <Spinner /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th style={{ width: 64 }}>顺序</th><th>方式</th><th>说明</th><th className="num">状态</th><th>操作</th></tr></thead>
              <tbody>
                {(list.data ?? []).map((m, i) => (
                  <tr key={m.id}>
                    <td data-label="顺序">
                      <div style={{ display: 'flex', gap: 4 }}>
                        {i > 0 && (
                          <button className="icon-btn" title="上移"
                                  onClick={async () => {
                                    const prev = list.data![i - 1]
                                    try {
                                      await api.patch(`/api/payment-methods/${m.id}`, { sort_order: prev.sort_order })
                                      await api.patch(`/api/payment-methods/${prev.id}`, { sort_order: m.sort_order })
                                      toast('顺序已调整')
                                      invalidate()
                                    } catch (e: any) { toast(e.message ?? '操作失败') }
                                  }}>
                            ↑
                          </button>
                        )}
                        <span className="hint" style={{ alignSelf: 'center' }}>{i + 1}</span>
                      </div>
                    </td>
                    <td data-label="方式" className="strong">{m.name}</td>
                    <td data-label="说明">{m.remark || '—'}</td>
                    <td className="num" data-label="状态">{m.is_active ? <Badge color="green">启用</Badge> : <Badge color="gray">停用</Badge>}</td>
                    <td className="no-label">
                      <button className="btn btn-quiet btn-sm" onClick={() => setEditing(m)}>编辑</button>
                      <button
                        className="btn btn-quiet btn-sm"
                        onClick={() => mut.mutate({ method: 'patch', path: `/api/payment-methods/${m.id}`, body: { is_active: !m.is_active } })}
                      >{m.is_active ? '停用' : '启用'}</button>
                      <button className="btn btn-quiet btn-sm" style={{ color: 'var(--danger-deep)' }} onClick={() => del.mutate(m.id)}>删除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card card-pad mt-16">
        <div className="section-title" style={{ marginBottom: 10 }}>效果预览</div>
        <div className="segmented" style={{ maxWidth: 600 }}>
          {actives.slice(0, 5).map((m, i) => (
            <button key={m.id} className={i === 0 ? 'active' : ''}>{m.name}</button>
          ))}
        </div>
        <p className="hint mt-8">新增或停用后，前台收款、入住登记与账务明细中的收款方式选项实时生效；有收款记录的方式不可删除，仅可停用。</p>
      </div>

      <PayMethodDialog
        open={addOpen} onClose={() => setAddOpen(false)}
        title="添加收款方式" submitText="创建方式"
        onSubmit={(b) => mut.mutate({ method: 'post', path: '/api/payment-methods', body: b })}
      />
      <PayMethodDialog
        open={editing !== null} onClose={() => setEditing(null)}
        title="编辑收款方式" submitText="保存修改" initial={editing ?? undefined}
        onSubmit={(b) => mut.mutate({ method: 'patch', path: `/api/payment-methods/${editing!.id}`, body: b })}
      />
    </>
  )
}

function PayMethodDialog({ open, onClose, onSubmit, title, submitText, initial }: {
  open: boolean; onClose: () => void
  onSubmit: (b: { name: string; remark: string }) => void
  title: string; submitText: string; initial?: PayMethod
}) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [remark, setRemark] = useState('')
  useEffect(() => { if (open) { setName(initial?.name ?? ''); setRemark(initial?.remark ?? '') } }, [open, initial])
  return (
    <Dialog
      open={open} onClose={onClose} title={title}
      foot={
        <>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary" disabled={!name.trim()}
            onClick={() => {
              if (!name.trim()) { toast('请输入方式名称'); return }
              onSubmit({ name: name.trim(), remark: remark.trim() })
              onClose()
            }}
          >{submitText}</button>
        </>
      }
    >
      <Field label="方式名称" required><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="如：协议挂账" /></Field>
      <Field label="说明" hint="选填，仅用于设置页备注。">
        <input className="input" value={remark} onChange={e => setRemark(e.target.value)} placeholder="如：挂账协议单位，月末统一结算" />
      </Field>
    </Dialog>
  )
}

/* ==================== 房型 ==================== */
function TypesTab() {
  const toast = useToast()
  const qc = useQueryClient()
  /** 编辑目标房型（null = 不打开；'new' = 新建） */
  const [editing, setEditing] = useState<RoomType | 'new' | null>(null)
  const [fName, setFName] = useState('')
  const [fPrice, setFPrice] = useState('')
  /** 钟点价档位行（hours=0 表示未填写；price 走字符串以便输入中显示） */
  const [fTiers, setFTiers] = useState<{ hours: string; price: string }[]>([])
  const [fCap, setFCap] = useState(2)
  const [fDesc, setFDesc] = useState('')
  const list = useQuery({ queryKey: ['room-types'], queryFn: () => api.get<RoomType[]>('/api/room-types') })
  const mut = useMutation({
    mutationFn: (p: { method: string; path: string; body?: any }) =>
      p.method === 'post' ? api.post(p.path, p.body) : api.patch(p.path, p.body),
    onSuccess: (_d, p) => { toast(p.method === 'post' ? '房型已创建' : '房型已更新'); qc.invalidateQueries({ queryKey: ['room-types'] }) },
    onError: (e: any) => toast(e.message ?? '操作失败'),
  })
  const delMut = useMutation({
    mutationFn: (id: number) => api.delete(`/api/room-types/${id}`),
    onSuccess: () => { toast('房型已删除'); qc.invalidateQueries({ queryKey: ['room-types'] }) },
    onError: (e: any) => toast(e.message ?? '删除失败'),
  })

  const openEdit = (t: RoomType | 'new') => {
    if (t === 'new') {
      setFName(''); setFPrice(''); setFTiers([]); setFCap(2); setFDesc('')
    } else {
      setFName(t.name); setFPrice(String(t.base_price))
      setFTiers((t.hourly_rates ?? []).map(x => ({ hours: String(x.hours), price: String(x.price) })))
      setFCap(t.capacity); setFDesc(t.description)
    }
    setEditing(t)
  }

  const setTier = (idx: number, patch: Partial<{ hours: string; price: string }>) => {
    setFTiers(rows => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }
  const addTier = () => setFTiers(rows => [...rows, { hours: '', price: '' }])
  const removeTier = (idx: number) => setFTiers(rows => rows.filter((_, i) => i !== idx))

  const submit = () => {
    const price = round2(Number(fPrice))
    if (!fName.trim() || !price) { toast('请填写名称与价格'); return }
    // 档位规整：hours 1–12 整数、price > 0、同房型小时不重复；整行全空 = 忽略
    const seen = new Set<number>()
    const tiers: { hours: number; price: number }[] = []
    for (const r of fTiers) {
      const h = Math.round(Number(r.hours))
      const p = round2(Number(r.price) || 0)
      if (r.hours === '' && r.price === '') continue
      if (!Number.isInteger(h) || h < 1 || h > 12) { toast('档位时长需为 1–12 整小时'); return }
      if (p <= 0) { toast('档位价格需大于 0'); return }
      if (seen.has(h)) { toast(`同一时长的档位重复了（${h} 小时），请合并为一档`); return }
      seen.add(h)
      tiers.push({ hours: h, price: p })
    }
    tiers.sort((a, b) => a.hours - b.hours)
    const body = {
      name: fName, base_price: price,
      hourly_price: tiers.length ? round2(tiers[tiers.length - 1].price / tiers[tiers.length - 1].hours) : 0,
      hourly_rates: tiers,
      capacity: fCap, description: fDesc,
    }
    if (editing === 'new') mut.mutate({ method: 'post', path: '/api/room-types', body })
    else if (editing) mut.mutate({ method: 'patch', path: `/api/room-types/${editing.id}`, body })
    setEditing(null)
  }

  const dialogOpen = editing !== null
  const dialogTitle = editing === 'new' ? '添加房型' : '编辑房型'
  return (
    <>
      <div className="card">
        <div className="card-head">
          <div className="section-sub" style={{ fontSize: 13.5 }}>共 {(list.data ?? []).length} 种房型</div>
          <button className="btn btn-primary btn-sm" onClick={() => openEdit('new')}>添加房型</button>
        </div>
        {list.isLoading ? <Spinner /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>房型</th><th className="num">基准价</th><th>钟点价（按档位）</th><th className="num">可住</th><th className="num">间数</th><th>说明</th><th>操作</th></tr></thead>
              <tbody>
                {(list.data ?? []).map(t => (
                  <tr key={t.id}>
                    <td data-label="房型" className="strong">{t.name}</td>
                    <td className="num" data-label="基准价">{fmtMoney(t.base_price)}</td>
                    <td data-label="钟点价（按档位）" className="hourly-cell">
                      {(t.hourly_rates ?? []).length
                        ? t.hourly_rates.map(x => `${x.hours}h ${fmtMoney(x.price)}`).join(' · ')
                        : <span className="muted">不支持</span>}
                    </td>
                    <td className="num" data-label="可住">{t.capacity} 人</td>
                    <td className="num" data-label="间数">{t.room_count}</td>
                    <td data-label="说明">{t.description || '—'}</td>
                    <td className="no-label">
                      <button className="btn btn-quiet btn-sm" onClick={() => openEdit(t)}>编辑</button>
                      <button className="btn btn-quiet btn-sm" style={{ color: 'var(--danger-deep)' }}
                              onClick={() => delMut.mutate(t.id)}>删除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Dialog
        open={dialogOpen} onClose={() => setEditing(null)} title={dialogTitle}
        foot={
          <>
            <button className="btn btn-ghost" onClick={() => setEditing(null)}>取消</button>
            <button className="btn btn-primary" onClick={submit}>{editing === 'new' ? '创建房型' : '保存修改'}</button>
          </>
        }
      >
        <Field label="房型名称" required><input className="input" value={fName} onChange={e => setFName(e.target.value)} placeholder="如：商务大床房" /></Field>
        <div className="form-row">
          <Field label="基准价" required hint="整晚价格（元/晚），支持到分。">
            <input className="input" type="number" min="0" step="0.01" value={fPrice} onChange={e => setFPrice(e.target.value)} placeholder="每晚价格" />
          </Field>
          <Field label="可住人数">
            <select className="select" value={fCap} onChange={e => setFCap(Number(e.target.value))}><option value={2}>2 人</option><option value={3}>3 人</option><option value={4}>4 人</option></select>
          </Field>
        </div>
        <Field label="钟点价档位（选填，按档位设置）">
          <div className="tier-lines">
            {fTiers.map((r, i) => (
              <div className="tier-line" key={i}>
                <input className="input tier-h" type="number" min={1} max={12} step={1} placeholder="小时"
                       value={r.hours} onChange={e => setTier(i, { hours: e.target.value })} />
                <span className="tier-sep">小时 /</span>
                <input className="input tier-p" type="number" min={0} step="0.01" placeholder="价格"
                       value={r.price} onChange={e => setTier(i, { price: e.target.value })} />
                <span className="tier-sep">元（整单总价）</span>
                <button type="button" className="icon-btn tier-del" title="删除该档" aria-label="删除该档" onClick={() => removeTier(i)}>
                  <X size={15} />
                </button>
              </div>
            ))}
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={addTier} style={{ alignSelf: 'flex-start' }}>＋ 添加档位</button>
          <span className="hint">每档 = 「时长 / 该时长的整单总价」，如 2 小时 ¥80。开单时长只提供已配档位，总额可议价；全部删除即该房型不支持钟点房。同房型时长不可重复，1–12 小时。支持到分。</span>
        </Field>
        <Field label="说明"><textarea className="input" rows={2} value={fDesc} onChange={e => setFDesc(e.target.value)} placeholder="床型、景观、设施等" /></Field>
      </Dialog>
    </>
  )
}

/* ==================== 客房 ==================== */
function RoomsTab() {
  const toast = useToast()
  const qc = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)
  const [nrNo, setNrNo] = useState('')
  const [nrFloor, setNrFloor] = useState(2)
  const [nrType, setNrType] = useState<number | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<Room | null>(null)
  const [edNo, setEdNo] = useState('')
  const [edFloor, setEdFloor] = useState(1)
  const [edType, setEdType] = useState<number | null>(null)
  const [edNotes, setEdNotes] = useState('')
  const types = useQuery({ queryKey: ['room-types'], queryFn: () => api.get<RoomType[]>('/api/room-types') })
  const rooms = useQuery({ queryKey: ['rooms'], queryFn: () => api.get<Room[]>('/api/rooms') })
  const statusMut = useMutation({
    mutationFn: (p: { id: number; status: string; label: string }) => api.patch(`/api/rooms/${p.id}`, { status: p.status }),
    onSuccess: (_d, p) => { toast(p.label); qc.invalidateQueries({ queryKey: ['rooms'] }) },
    onError: (e: any) => toast(e.message ?? '操作失败'),
  })
  const createMut = useMutation({
    mutationFn: (body: any) => api.post('/api/rooms', body),
    onSuccess: () => { toast('客房已创建，初始房态为空净'); setAddOpen(false); qc.invalidateQueries({ queryKey: ['rooms'] }) },
    onError: (e: any) => toast(e.message ?? '创建失败'),
  })
  const editMut = useMutation({
    mutationFn: (p: { id: number; body: any }) => api.patch(`/api/rooms/${p.id}`, p.body),
    onSuccess: () => { toast('客房信息已更新'); setEditOpen(false); qc.invalidateQueries({ queryKey: ['rooms'] }) },
    onError: (e: any) => toast(e.message ?? '保存失败'),
  })
  /** 待删除客房（null = 不打开确认弹层）；在住房不提供删除入口（必然有预订，后端会拒） */
  const [delRes, setDelRes] = useState<Room | null>(null)
  const delMut = useMutation({
    mutationFn: (id: number) => api.delete(`/api/rooms/${id}`),
    onSuccess: () => {
      toast('客房已删除')
      setDelRes(null)
      // 房型的「间数」列随删除减少，一并失效
      qc.invalidateQueries({ queryKey: ['rooms'] })
      qc.invalidateQueries({ queryKey: ['room-types'] })
    },
    onError: (e: any) => toast(e.message ?? '删除失败'),
  })
  const openEdit = (r: Room) => {
    setEditing(r)
    setEdNo(r.room_number)
    setEdFloor(r.floor)
    setEdType(r.room_type_id)
    setEdNotes(r.notes || '')
    setEditOpen(true)
  }

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div className="section-sub" style={{ fontSize: 13.5 }}>共 {(rooms.data ?? []).length} 间客房</div>
          <button className="btn btn-primary btn-sm" onClick={() => setAddOpen(true)}>添加客房</button>
        </div>
        {rooms.isLoading ? <Spinner /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>房号</th><th>楼层</th><th>房型</th><th>当前状态</th><th>备注</th><th>操作</th></tr></thead>
              <tbody>
                {(rooms.data ?? []).map(r => (
                  <tr key={r.id}>
                    <td data-label="房号" className="strong">{r.room_number}</td>
                    <td data-label="楼层">{r.floor}F</td>
                    <td data-label="房型">{r.room_type_name}</td>
                    <td data-label="当前状态">
                      {r.status === 'occupied' ? <Badge color="blue">在住</Badge>
                        : r.status === 'vacant_clean' ? <Badge color="green">空净</Badge>
                        : r.status === 'vacant_dirty' ? <Badge color="orange">空脏</Badge>
                        : <Badge color="red">维修</Badge>}
                    </td>
                    <td data-label="备注">{r.notes || '—'}</td>
                    <td className="no-label">
                      {r.status === 'occupied' && <span className="hint">在住中</span>}
                      {r.status === 'maintenance' && (
                        // 维修功能已下线：历史库残留的维修房给「完成维修」兜底入口
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => statusMut.mutate({ id: r.id, status: 'vacant_clean', label: `${r.room_number} 维修完成，转为空净` })}
                        >完成维修</button>
                      )}
                      {(r.status === 'vacant_clean' || r.status === 'vacant_dirty') && (
                        <select
                          className="select" style={{ height: 32, fontSize: 12.5, width: 110 }}
                          value={r.status}
                          onChange={e => statusMut.mutate({ id: r.id, status: e.target.value, label: `${r.room_number} 房态已更新` })}
                        >
                          <option value="vacant_clean">空净</option>
                          <option value="vacant_dirty">空脏</option>
                        </select>
                      )}
                      <button className="btn btn-quiet btn-sm" style={{ marginLeft: 6 }} onClick={() => openEdit(r)}>编辑</button>
                      {r.status !== 'occupied' && (
                        <button className="btn btn-quiet btn-sm" style={{ color: 'var(--danger-deep)' }}
                                onClick={() => setDelRes(r)}>删除</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Dialog
        open={addOpen} onClose={() => setAddOpen(false)} title="添加客房"
        foot={
          <>
            <button className="btn btn-ghost" onClick={() => setAddOpen(false)}>取消</button>
            <button className="btn btn-primary" onClick={() => {
              if (!nrNo.trim() || !nrType) { toast('请填写房号与房型'); return }
              createMut.mutate({ room_number: nrNo.trim(), floor: nrFloor, room_type_id: nrType })
              setNrNo(''); setNrType(null)
            }}>创建客房</button>
          </>
        }
      >
        <div className="form-row">
          <Field label="房号" required><input className="input" value={nrNo} onChange={e => setNrNo(e.target.value)} placeholder="如 509" /></Field>
          <Field label="楼层" required><input className="input" type="number" value={nrFloor} onChange={e => setNrFloor(Number(e.target.value))} /></Field>
        </div>
        <Field label="房型" required>
          <select className="select" value={nrType ?? ''} onChange={e => setNrType(Number(e.target.value))}>
            <option value="">请选择房型</option>
            {(types.data ?? []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
      </Dialog>

      <Dialog
        open={editOpen} onClose={() => setEditOpen(false)} title="编辑客房"
        foot={
          <>
            <button className="btn btn-ghost" onClick={() => setEditOpen(false)}>取消</button>
            <button className="btn btn-primary" disabled={editMut.isPending} onClick={() => {
              if (!editing) return
              if (!edNo.trim()) { toast('请填写房号'); return }
              if (!edType) { toast('请选择房型'); return }
              editMut.mutate({ id: editing.id, body: {
                room_number: edNo.trim(), floor: edFloor, room_type_id: edType, notes: edNotes,
              } })
            }}>保存修改</button>
          </>
        }
      >
        <div className="form-row">
          <Field label="房号" required><input className="input" value={edNo} onChange={e => setEdNo(e.target.value)} placeholder="如 509" /></Field>
          <Field label="楼层" required><input className="input" type="number" value={edFloor} onChange={e => setEdFloor(Number(e.target.value))} /></Field>
        </div>
        <Field label="房型" required>
          <select className="select" value={edType ?? ''} onChange={e => setEdType(Number(e.target.value))}>
            <option value="">请选择房型</option>
            {(types.data ?? []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <Field label="备注">
          <textarea className="input" rows={2} value={edNotes} onChange={e => setEdNotes(e.target.value)} placeholder="选填，如 空调检修，预计 11/20 恢复" />
        </Field>
        <p className="hint mt-8">房号需全店唯一，不可与现有客房重复；修改保存后即时生效。</p>
      </Dialog>

      <ConfirmDialog
        open={!!delRes} onClose={() => setDelRes(null)}
        title="删除客房" sub={delRes ? `${delRes.room_number} · ${delRes.room_type_name}` : ''}
        confirmText="删除" busy={delMut.isPending}
        onConfirm={() => { if (delRes) delMut.mutate(delRes.id) }}
      >
        <p className="confirm-msg">确定删除这间客房吗？</p>
        <div className="info-row"><span>房号</span><span>{delRes?.room_number}</span></div>
        <div className="info-row"><span>房型 / 楼层</span><span>{delRes ? `${delRes.room_type_name} · ${delRes.floor}F` : ''}</span></div>
        <div className="info-row"><span>当前状态</span><span>{delRes?.status === 'vacant_clean' ? '空净' : delRes?.status === 'vacant_dirty' ? '空脏' : delRes?.status === 'maintenance' ? '维修' : '在住'}</span></div>
        <div className="danger-note">删除后该客房将从本店<b>永久移除</b>（房态盘与客房列表同步消失），操作写入酒店日志。仅<b>无任何预订记录</b>（含历史）的客房可删除；有在住客人或历史预订时会被拒绝，只能调整房态或保留档案。</div>
      </ConfirmDialog>
    </>
  )
}

/* ==================== 员工 ==================== */
/** 绑定酒店多选卡片组：勾选顺序即主店（第一个勾选 = 主店，登录后默认进入） */
function HotelPicks({ hotels, selected, onChange }: {
  hotels: Hotel[]
  selected: number[]
  onChange: (ids: number[]) => void
}) {
  const toggle = (id: number) => {
    if (selected.includes(id)) {
      onChange(selected.filter(x => x !== id))
    } else {
      onChange([...selected, id])
    }
  }
  if (!hotels.length) return <Spinner />
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {hotels.map(h => {
          const idx = selected.indexOf(h.id)
          const isMain = idx === 0
          return (
            <label
              key={h.id}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                border: `1px solid ${idx >= 0 ? 'var(--accent-line)' : 'var(--hairline-soft)'}`,
                background: idx >= 0 ? 'var(--accent-soft)' : 'transparent',
                borderRadius: 999, padding: '8px 14px', fontSize: 14,
                cursor: 'pointer', userSelect: 'none', transition: 'border-color .15s, background .15s',
              }}
            >
              <input
                type="checkbox"
                checked={idx >= 0}
                onChange={() => toggle(h.id)}
                style={{ accentColor: 'var(--accent)', margin: 0 }}
              />
              <span>{h.name}</span>
              {isMain && (
                <span style={{ fontSize: 11, color: 'var(--on-accent)', background: 'var(--accent)', borderRadius: 999, padding: '1.5px 7px' }}>主店</span>
              )}
            </label>
          )
        })}
      </div>
      <span className="hint" style={{ display: 'block', marginTop: 6 }}>
        可勾选多家；第一个勾选的为<b>主店</b>（登录后默认进入）。绑定多店的账号登录后可在顶栏切换酒店。
      </span>
    </>
  )
}

function StaffTab({ users, loading }: { users?: UserRow[]; loading: boolean }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { user, activeHotelId } = useAuth()
  const hotels = useQuery({ queryKey: ['hotels'], queryFn: () => api.get<Hotel[]>('/api/hotels') })
  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<UserRow | null>(null)
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['users'] })
    qc.invalidateQueries({ queryKey: ['hotels'] })
  }
  const mut = useMutation({
    mutationFn: (body: any) => api.post('/api/users', body),
    onSuccess: () => { toast('员工账号已创建'); setAddOpen(false); invalidate() },
    onError: (e: any) => toast(e.message ?? '创建失败'),
  })
  const toggleMut = useMutation({
    mutationFn: (p: { id: number; is_active: boolean }) => api.patch(`/api/users/${p.id}`, { is_active: p.is_active }),
    onSuccess: () => { toast('员工状态已更新'); qc.invalidateQueries({ queryKey: ['users'] }) },
    onError: (e: any) => toast(e.message ?? '操作失败'),
  })
  const bindMut = useMutation({
    mutationFn: (p: { id: number; hotel_ids: number[] }) => api.patch(`/api/users/${p.id}`, { hotel_ids: p.hotel_ids }),
    onSuccess: () => { toast('员工绑定已保存'); setEditTarget(null); invalidate() },
    onError: (e: any) => toast(e.message ?? '保存失败'),
  })
  const canCreate = user?.role === 'platform_admin' || user?.role === 'admin'

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div className="section-sub" style={{ fontSize: 13.5 }}>
            共 {(users ?? []).length} 位员工{user?.role === 'platform_admin' && activeHotelId ? '（当前所选酒店）' : ''}
          </div>
          {canCreate && <button className="btn btn-primary btn-sm" onClick={() => setAddOpen(true)}>添加员工</button>}
        </div>
        {loading ? <Spinner /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>姓名</th><th>账号</th><th>所属酒店</th><th>角色</th><th>状态</th><th>最近登录</th><th>操作</th></tr></thead>
              <tbody>
                {(users ?? []).map(u => (
                  <tr key={u.id}>
                    <td data-label="姓名">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span className="avatar sm">{u.name.charAt(0)}</span>
                        <span className="cell-main">{u.name}</span>
                      </div>
                    </td>
                    <td data-label="账号">{u.username}</td>
                    <td data-label="所属酒店">
                      {u.hotels?.length
                        ? (
                          <span style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                            {u.hotels.map((h, i) => (
                              <span key={h.id}>
                                {i > 0 && ' · '}
                                <span>{h.name}</span>
                                {i === 0 && (
                                  <span style={{ fontSize: 11, color: 'var(--on-accent)', background: 'var(--accent)', borderRadius: 999, padding: '1px 6px', marginLeft: 4 }}>主店</span>
                                )}
                              </span>
                            ))}
                          </span>
                        )
                        : (u.hotel_name ?? '平台')}
                    </td>
                    <td data-label="角色"><Badge color="gray">{u.role_label}</Badge></td>
                    <td data-label="状态">{u.is_active ? <Badge color="green">启用</Badge> : <Badge color="orange">停用</Badge>}</td>
                    <td data-label="最近登录">{u.last_login_at ? u.last_login_at.slice(5, 16).replace('T', ' ') : '—'}</td>
                    <td className="no-label">
                      {u.id !== user?.id && (
                        <>
                          <button
                            className="btn btn-quiet btn-sm"
                            onClick={() => setEditTarget(u)}
                          >绑定</button>
                          <button
                            className="btn btn-quiet btn-sm"
                            onClick={() => toggleMut.mutate({ id: u.id, is_active: !u.is_active })}
                          >{u.is_active ? '停用' : '启用'}</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="hint mt-16">权限说明：超级管理员可管理全部酒店与员工绑定；酒店管理员可管理本店员工与配置；前台可操作房态、预订、入住退房与收款。</p>

      <AddStaffDialog
        open={addOpen} onClose={() => setAddOpen(false)}
        hotels={hotels.data ?? []}
        canPickHotel={user?.role === 'platform_admin'}
        defaultHotelId={activeHotelId}
        onSubmit={(b) => mut.mutate(b)}
      />
      <EditStaffDialog
        target={editTarget}
        hotels={hotels.data ?? []}
        canEdit={user?.role === 'platform_admin'}
        onClose={() => setEditTarget(null)}
        onSubmit={(ids) => bindMut.mutate({ id: editTarget!.id, hotel_ids: ids })}
        busy={bindMut.isPending}
      />
    </>
  )
}

function AddStaffDialog({ open, onClose, hotels, canPickHotel, defaultHotelId, onSubmit }: {
  open: boolean; onClose: () => void; hotels: Hotel[]
  canPickHotel: boolean; defaultHotelId: number | null
  onSubmit: (b: any) => void
}) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [hotelIds, setHotelIds] = useState<number[]>([])
  const [role, setRole] = useState('receptionist')
  const [pwd, setPwd] = useState('yunqi123')
  useEffect(() => {
    if (open) {
      setName(''); setUsername(''); setRole('receptionist'); setPwd('yunqi123')
      setHotelIds(defaultHotelId ? [defaultHotelId] : [])
    }
  }, [open, defaultHotelId])

  return (
    <Dialog
      open={open} onClose={onClose} title="添加员工"
      foot={
        <>
          <span className="hint" style={{ marginRight: 'auto' }}>操作人：当前登录账号</span>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary"
            onClick={() => {
              if (!name.trim() || !username.trim()) { toast('请填写姓名与账号'); return }
              if (canPickHotel && !hotelIds.length) { toast('请选择所属酒店'); return }
              onSubmit({ name, username, password: pwd, role, hotel_ids: hotelIds })
            }}
          >创建账号</button>
        </>
      }
    >
      <div className="form-row">
        <Field label="姓名" required><input className="input" value={name} onChange={e => setName(e.target.value)} /></Field>
        <Field label="登录账号" required><input className="input" value={username} onChange={e => setUsername(e.target.value)} placeholder="字母或拼音" /></Field>
      </div>
      {canPickHotel && (
        <Field label="所属酒店" required>
          <HotelPicks hotels={hotels} selected={hotelIds} onChange={setHotelIds} />
        </Field>
      )}
      <div className="form-row">
        <Field label="角色">
          <select className="select" value={role} onChange={e => setRole(e.target.value)}>
            <option value="receptionist">前台</option><option value="admin">管理员</option>
          </select>
        </Field>
        <Field label="初始密码"><input className="input" value={pwd} onChange={e => setPwd(e.target.value)} /></Field>
      </div>
      <p className="hint">密码至少 6 位；创建后请提醒员工首次登录修改密码。</p>
    </Dialog>
  )
}

/** 编辑员工绑定：仅超级管理员可改（酒店管理员越权提交会被后端 400 拦截） */
function EditStaffDialog({ target, hotels, canEdit, onClose, onSubmit, busy }: {
  target: UserRow | null
  hotels: Hotel[]
  canEdit: boolean
  onClose: () => void
  onSubmit: (ids: number[]) => void
  busy: boolean
}) {
  const toast = useToast()
  const [ids, setIds] = useState<number[]>([])
  useEffect(() => {
    if (target) setIds(target.hotels?.length ? target.hotels.map(h => h.id) : (target.hotel_id ? [target.hotel_id] : []))
  }, [target])

  return (
    <Dialog
      open={!!target} onClose={onClose} title="编辑员工绑定"
      foot={
        <>
          <span className="hint" style={{ marginRight: 'auto' }}>
            {canEdit ? '减绑后员工将无法再访问被移除酒店的数据' : '仅超级管理员可修改员工绑定'}
          </span>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary"
            disabled={!canEdit || busy}
            onClick={() => {
              if (!ids.length) { toast('至少绑定一家酒店'); return }
              onSubmit(ids)
            }}
          >保存绑定</button>
        </>
      }
    >
      <Field label="员工"><input className="input" value={target?.name ?? ''} disabled /></Field>
      <Field label="绑定酒店" required>
        <HotelPicks hotels={hotels} selected={ids} onChange={setIds} />
      </Field>
    </Dialog>
  )
}
