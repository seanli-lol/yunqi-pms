import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, fmtMoney, maskPhone, type Channel, type Hotel, type Room, type RoomType, type UserRow } from '../api'
import { useAuth } from '../auth'
import { Badge, Dialog, Field, PageHead, Segmented, Spinner, useToast } from '../ui'

type Tab = 'hotels' | 'channels' | 'types' | 'rooms' | 'staff'

export default function Settings() {
  const toast = useToast()
  const qc = useQueryClient()
  const { user, activeHotelId, activeHotelName, setActiveHotel } = useAuth()
  const [tab, setTab] = useState<Tab>('hotels')

  const hotels = useQuery({ queryKey: ['hotels'], queryFn: () => api.get<Hotel[]>('/api/hotels') })
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<UserRow[]>('/api/users') })

  // 平台管理员首次进入：自动选中第一家酒店作为业务上下文
  useEffect(() => {
    if (user?.role === 'platform_admin' && !activeHotelId && hotels.data?.length) {
      setActiveHotel(hotels.data[0].id, hotels.data[0].name)
    }
  }, [user, activeHotelId, hotels.data, setActiveHotel])

  return (
    <>
      <PageHead
        title="系统设置"
        desc="酒店（多店隔离）、来源渠道、房型、客房与员工账号"
      />

      {user?.role === 'platform_admin' && (
        <div className="card card-pad mb-24" style={{ padding: '14px 24px' }}>
          <div className="flex-between">
            <span className="hint" style={{ fontSize: 13 }}>
              平台管理员视角：请先选择要管理的酒店，下方各业务 Tab 的数据将随所选酒店切换。
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
            { key: 'types', label: '房型管理' },
            { key: 'rooms', label: '客房管理' },
            { key: 'staff', label: '员工账号' },
          ]}
          onChange={setTab}
        />
      </div>

      {tab === 'hotels' && <HotelsTab data={hotels.data} loading={hotels.isLoading} isAdmin={user?.role === 'platform_admin'} />}
      {tab === 'channels' && <ChannelsTab />}
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
  const mut = useMutation({
    mutationFn: (body: any) => api.post('/api/hotels', body),
    onSuccess: () => { toast('酒店已创建，数据将完全隔离'); setAddOpen(false); qc.invalidateQueries({ queryKey: ['hotels'] }) },
    onError: (e: any) => toast(e.message ?? '创建失败'),
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
                    <td className="no-label"><button className="btn btn-quiet btn-sm" onClick={() => toast('编辑酒店信息（演示）')}>编辑</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="hint mt-16">
        {isAdmin
          ? '仅平台管理员可添加酒店；每家酒店拥有独立的房态、预订、账务与报表数据，互不干扰。'
          : '您管理的酒店数据与其他门店完全隔离。'}
      </p>

      <AddHotelDialog open={addOpen} onClose={() => setAddOpen(false)} onSubmit={(b) => mut.mutate(b)} busy={mut.isPending} />
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

/* ==================== 房型 ==================== */
function TypesTab() {
  const toast = useToast()
  const qc = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)
  const [fName, setFName] = useState('')
  const [fPrice, setFPrice] = useState('')
  const [fCap, setFCap] = useState(2)
  const [fDesc, setFDesc] = useState('')
  const list = useQuery({ queryKey: ['room-types'], queryFn: () => api.get<RoomType[]>('/api/room-types') })
  const mut = useMutation({
    mutationFn: (p: { method: string; path: string; body?: any }) =>
      p.method === 'post' ? api.post(p.path, p.body) : api.patch(p.path, p.body),
    onSuccess: (d: any, p) => { toast(p.method === 'post' ? '房型已创建' : '房型已更新'); qc.invalidateQueries({ queryKey: ['room-types'] }) },
    onError: (e: any) => toast(e.message ?? '操作失败'),
  })
  const delMut = useMutation({
    mutationFn: (id: number) => api.delete(`/api/room-types/${id}`),
    onSuccess: () => { toast('房型已删除'); qc.invalidateQueries({ queryKey: ['room-types'] }) },
    onError: (e: any) => toast(e.message ?? '删除失败'),
  })

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div className="section-sub" style={{ fontSize: 13.5 }}>共 {(list.data ?? []).length} 种房型</div>
          <button className="btn btn-primary btn-sm" onClick={() => setAddOpen(true)}>添加房型</button>
        </div>
        {list.isLoading ? <Spinner /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>房型</th><th className="num">基准价</th><th className="num">可住</th><th className="num">间数</th><th>说明</th><th>操作</th></tr></thead>
              <tbody>
                {(list.data ?? []).map(t => (
                  <tr key={t.id}>
                    <td data-label="房型" className="strong">{t.name}</td>
                    <td className="num" data-label="基准价">{fmtMoney(t.base_price)}</td>
                    <td className="num" data-label="可住">{t.capacity} 人</td>
                    <td className="num" data-label="间数">{t.room_count}</td>
                    <td data-label="说明">{t.description || '—'}</td>
                    <td className="no-label">
                      <button className="btn btn-quiet btn-sm" onClick={() => toast('编辑房型（演示）')}>编辑</button>
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
        open={addOpen} onClose={() => setAddOpen(false)} title="添加房型"
        foot={
          <>
            <button className="btn btn-ghost" onClick={() => setAddOpen(false)}>取消</button>
            <button className="btn btn-primary" onClick={() => {
              const price = Number(fPrice)
              if (!fName.trim() || !price) { toast('请填写名称与价格'); return }
              mut.mutate({ method: 'post', path: '/api/room-types', body: { name: fName, base_price: price, capacity: fCap, description: fDesc } })
              setFName(''); setFPrice(''); setFCap(2); setFDesc('')
              setAddOpen(false)
            }}>创建房型</button>
          </>
        }
      >
        <Field label="房型名称" required><input className="input" value={fName} onChange={e => setFName(e.target.value)} placeholder="如：商务大床房" /></Field>
        <div className="form-row">
          <Field label="基准价" required><input className="input" type="number" value={fPrice} onChange={e => setFPrice(e.target.value)} placeholder="每晚价格" /></Field>
          <Field label="可住人数">
            <select className="select" value={fCap} onChange={e => setFCap(Number(e.target.value))}><option value={2}>2 人</option><option value={3}>3 人</option><option value={4}>4 人</option></select>
          </Field>
        </div>
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
                      {r.status !== 'occupied' && (
                        <select
                          className="select" style={{ height: 32, fontSize: 12.5, width: 110 }}
                          value={r.status}
                          onChange={e => statusMut.mutate({ id: r.id, status: e.target.value, label: `${r.room_number} 房态已更新` })}
                        >
                          <option value="vacant_clean">空净</option>
                          <option value="vacant_dirty">空脏</option>
                          <option value="maintenance">维修</option>
                        </select>
                      )}
                      {r.status === 'occupied' && <span className="hint">在住中</span>}
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
    </>
  )
}

/* ==================== 员工 ==================== */
function StaffTab({ users, loading }: { users?: UserRow[]; loading: boolean }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { user, activeHotelId } = useAuth()
  const hotels = useQuery({ queryKey: ['hotels'], queryFn: () => api.get<Hotel[]>('/api/hotels') })
  const [addOpen, setAddOpen] = useState(false)
  const mut = useMutation({
    mutationFn: (body: any) => api.post('/api/users', body),
    onSuccess: () => { toast('员工账号已创建'); setAddOpen(false); qc.invalidateQueries({ queryKey: ['users'] }) },
    onError: (e: any) => toast(e.message ?? '创建失败'),
  })
  const toggleMut = useMutation({
    mutationFn: (p: { id: number; is_active: boolean }) => api.patch(`/api/users/${p.id}`, { is_active: p.is_active }),
    onSuccess: () => { toast('员工状态已更新'); qc.invalidateQueries({ queryKey: ['users'] }) },
    onError: (e: any) => toast(e.message ?? '操作失败'),
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
                    <td data-label="所属酒店">{u.hotel_name ?? '平台'}</td>
                    <td data-label="角色"><Badge color="gray">{u.role_label}</Badge></td>
                    <td data-label="状态">{u.is_active ? <Badge color="green">启用</Badge> : <Badge color="orange">停用</Badge>}</td>
                    <td data-label="最近登录">{u.last_login_at ? u.last_login_at.slice(5, 16).replace('T', ' ') : '—'}</td>
                    <td className="no-label">
                      {u.id !== user?.id && (
                        <button
                          className="btn btn-quiet btn-sm"
                          onClick={() => toggleMut.mutate({ id: u.id, is_active: !u.is_active })}
                        >{u.is_active ? '停用' : '启用'}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="hint mt-16">权限说明：平台管理员可管理全部酒店；酒店管理员可管理本店员工与配置；前台可操作房态、预订、入住退房与收款；客房部仅可更新清洁任务。</p>

      <AddStaffDialog
        open={addOpen} onClose={() => setAddOpen(false)}
        hotels={hotels.data ?? []}
        canPickHotel={user?.role === 'platform_admin'}
        defaultHotelId={activeHotelId}
        onSubmit={(b) => mut.mutate(b)}
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
  const [hotelId, setHotelId] = useState<number | null>(defaultHotelId)
  const [role, setRole] = useState('receptionist')
  const [pwd, setPwd] = useState('yunqi123')
  useEffect(() => {
    if (open) { setName(''); setUsername(''); setRole('receptionist'); setPwd('yunqi123'); setHotelId(defaultHotelId) }
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
              if (canPickHotel && !hotelId) { toast('请选择所属酒店'); return }
              onSubmit({ name, username, password: pwd, role, hotel_id: hotelId })
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
        <Field label="所属酒店" required hint="员工登录时选择所属酒店；只能访问该酒店的数据。">
          <select className="select" value={hotelId ?? ''} onChange={e => setHotelId(Number(e.target.value))}>
            {hotels.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
        </Field>
      )}
      <div className="form-row">
        <Field label="角色">
          <select className="select" value={role} onChange={e => setRole(e.target.value)}>
            <option value="receptionist">前台</option><option value="housekeeper">客房部</option><option value="admin">管理员</option>
          </select>
        </Field>
        <Field label="初始密码"><input className="input" value={pwd} onChange={e => setPwd(e.target.value)} /></Field>
      </div>
      <p className="hint">密码至少 6 位；创建后请提醒员工首次登录修改密码。</p>
    </Dialog>
  )
}
