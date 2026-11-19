import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, fmtMoney, maskPhone, md, type Guest } from '../api'
import { Badge, Dialog, Drawer, Field, PageHead, Spinner, useToast } from '../ui'

const VIP_TABS = ['', 'VIP·黑金', 'VIP·金', 'VIP·银', '普通会员']

export default function Guests() {
  const toast = useToast()
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [vip, setVip] = useState('')
  const [detail, setDetail] = useState<Guest | null>(null)
  const [addOpen, setAddOpen] = useState(false)

  const list = useQuery({
    queryKey: ['guests', q, vip],
    queryFn: () => api.get<Guest[]>(`/api/guests?q=${encodeURIComponent(q)}&vip=${encodeURIComponent(vip)}`),
  })
  const detailQ = useQuery({
    queryKey: ['guest', detail?.id],
    enabled: detail !== null,
    queryFn: () => api.get<Guest>(`/api/guests/${detail!.id}`),
  })

  const addMut = useMutation({
    mutationFn: (body: any) => api.post('/api/guests', body),
    onSuccess: () => { toast('客户已创建'); setAddOpen(false); qc.invalidateQueries({ queryKey: ['guests'] }) },
    onError: (e: any) => toast(e.message ?? '创建失败'),
  })

  return (
    <>
      <PageHead
        title="客户档案"
        desc={`共 ${list.data?.length ?? 0} 位住客`}
        actions={<button className="btn btn-primary" onClick={() => setAddOpen(true)}>添加客户</button>}
      />

      <div className="filter-bar">
        <div className="search">
          <input className="input" type="search" placeholder="搜索姓名或手机号" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <div className="chips">
          {VIP_TABS.map(v => (
            <button key={v} className={`chip${vip === v ? ' active' : ''}`} onClick={() => setVip(v)}>
              {v || '全部'}
            </button>
          ))}
        </div>
      </div>

      {list.isLoading ? <Spinner /> : (
        <div className="card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>客人</th><th>会员等级</th><th>证件号</th><th className="num">历史入住</th><th className="num">累计消费</th><th>最近入住</th><th>操作</th></tr>
              </thead>
              <tbody>
                {list.data!.map(g => (
                  <tr key={g.id}>
                    <td data-label="客人">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span className="avatar sm">{g.name.charAt(0)}</span>
                        <div>
                          <div className="cell-main">{g.name}</div>
                          <div className="cell-sub">{maskPhone(g.phone)}</div>
                        </div>
                      </div>
                    </td>
                    <td data-label="会员等级">
                      {g.vip_level ? <Badge color={g.vip_level.includes('黑金') ? 'purple' : g.vip_level.includes('金') ? 'blue' : 'gray'}>{g.vip_level}</Badge> : <Badge color="gray">普通会员</Badge>}
                    </td>
                    <td data-label="证件号">{g.id_number || '—'}</td>
                    <td className="num" data-label="历史入住">{g.stay_count} 次</td>
                    <td className="num" data-label="累计消费">{fmtMoney(g.total_spend)}</td>
                    <td data-label="最近入住">{g.last_stay ? md(g.last_stay) : '—'}</td>
                    <td className="no-label"><button className="btn btn-quiet btn-sm" onClick={() => setDetail(g)}>查看档案</button></td>
                  </tr>
                ))}
                {list.data!.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 32 }}>暂无客户</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 档案抽屉 */}
      <Drawer
        open={detail !== null} onClose={() => setDetail(null)}
        title="客户档案"
        foot={
          <>
            <span className="hint" style={{ marginRight: 'auto' }}>操作人：当前登录账号</span>
            <button className="btn btn-primary" onClick={() => setDetail(null)}>关闭</button>
          </>
        }
      >
        {detailQ.isLoading || !detailQ.data ? <Spinner /> : (() => {
          const g = detailQ.data
          return (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <span className="avatar" style={{ width: 52, height: 52, fontSize: 20 }}>{g.name.charAt(0)}</span>
                <div>
                  <div style={{ fontSize: 19, fontWeight: 600 }}>
                    {g.name} {g.vip_level && <span style={{ marginLeft: 6 }}><Badge color={g.vip_level.includes('黑金') ? 'purple' : 'blue'}>{g.vip_level}</Badge></span>}
                  </div>
                  <div className="hint" style={{ marginTop: 3 }}>手机 {maskPhone(g.phone)}</div>
                </div>
              </div>
              <div className="grid-3 mt-16">
                <div className="card stat" style={{ padding: '14px 16px' }}><div className="stat-label">历史入住</div><div className="stat-value" style={{ fontSize: 22 }}>{g.stay_count}</div></div>
                <div className="card stat" style={{ padding: '14px 16px' }}><div className="stat-label">累计消费</div><div className="stat-value" style={{ fontSize: 22 }}>{fmtMoney(g.total_spend)}</div></div>
                <div className="card stat" style={{ padding: '14px 16px' }}><div className="stat-label">证件</div><div className="stat-value" style={{ fontSize: 22 }}>✓</div></div>
              </div>
              <div className="section-sub mt-24" style={{ marginBottom: 6 }}>历史入住</div>
              <div className="list" style={{ border: '1px solid var(--hairline-soft)', borderRadius: 14, overflow: 'hidden' }}>
                {g.history?.map(h => (
                  <div className="list-row" style={{ padding: '12px 16px' }} key={h.reservation_id}>
                    <span className="list-main">
                      <span className="list-title" style={{ fontWeight: 500, fontSize: 14.5 }}>
                        {h.room_number} · {md(h.check_in)} – {md(h.check_out)}
                      </span>
                    </span>
                    <span style={{ fontSize: 13.5, color: 'var(--text-secondary)' }}>{fmtMoney(h.amount)}</span>
                  </div>
                ))}
                {(g.history?.length ?? 0) === 0 && <div className="empty">暂无入住记录</div>}
              </div>
              {g.notes && <p className="hint mt-16">备注：{g.notes}</p>}
            </>
          )
        })()}
      </Drawer>

      {/* 添加客户 */}
      <AddGuestDialog open={addOpen} onClose={() => setAddOpen(false)} onSubmit={(b) => addMut.mutate(b)} busy={addMut.isPending} />
    </>
  )
}

function AddGuestDialog({ open, onClose, onSubmit, busy }: {
  open: boolean; onClose: () => void; onSubmit: (b: any) => void; busy: boolean
}) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [idNo, setIdNo] = useState('')
  const [vip, setVip] = useState('')
  const [notes, setNotes] = useState('')
  useEffect(() => { if (open) { setName(''); setPhone(''); setIdNo(''); setVip(''); setNotes('') } }, [open])
  return (
    <Dialog
      open={open} onClose={onClose} title="添加客户"
      foot={
        <>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={busy || !name.trim()}
                  onClick={() => {
                    if (!name.trim()) { toast('请输入姓名'); return }
                    onSubmit({ name, phone, id_number: idNo, vip_level: vip, notes })
                  }}>保存</button>
        </>
      }
    >
      <Field label="姓名" required><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="请输入姓名" /></Field>
      <div className="form-row">
        <Field label="手机号" required><input className="input" value={phone} onChange={e => setPhone(e.target.value)} placeholder="11 位手机号" /></Field>
        <Field label="会员等级">
          <select className="select" value={vip} onChange={e => setVip(e.target.value)}>
            <option value="">普通会员</option><option>VIP·银</option><option>VIP·金</option><option>VIP·黑金</option>
          </select>
        </Field>
      </div>
      <Field label="证件号"><input className="input" value={idNo} onChange={e => setIdNo(e.target.value)} placeholder="身份证 / 护照" /></Field>
      <Field label="备注"><input className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="偏好、忌口等" /></Field>
    </Dialog>
  )
}
