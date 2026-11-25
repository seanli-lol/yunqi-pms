import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, fmtMoney, md, type Guest } from '../api'
import { Dialog, Drawer, Field, PageHead, Spinner, useToast } from '../ui'

export default function Guests() {
  const toast = useToast()
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [detail, setDetail] = useState<Guest | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  /** 档案编辑（抽屉「编辑档案」弹层：姓名/手机号/证件号/备注一次保存） */
  const [editFor, setEditFor] = useState<Guest | null>(null)

  const list = useQuery({
    queryKey: ['guests', q],
    queryFn: () => api.get<Guest[]>(`/api/guests?q=${encodeURIComponent(q)}`),
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

  const editMut = useMutation({
    mutationFn: (p: { id: number; name: string; phone: string; id_number: string; notes: string }) =>
      api.patch(`/api/guests/${p.id}`, { name: p.name, phone: p.phone, id_number: p.id_number, notes: p.notes }),
    onSuccess: (_d, p) => {
      toast('档案已保存')
      setEditFor(null)
      qc.invalidateQueries({ queryKey: ['guests'] })
      qc.invalidateQueries({ queryKey: ['guest', p.id] })
    },
    onError: (e: any) => toast(e.message ?? '保存失败'),
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
          <input className="input" type="search" placeholder="搜索姓名、手机号或证件号" value={q} onChange={e => setQ(e.target.value)} />
        </div>
      </div>

      {list.isLoading ? <Spinner /> : (
        <div className="card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>客人名称</th><th>电话</th><th>证件号</th><th>备注</th><th className="num">历史入住</th><th className="num">累计消费</th><th>最近入住</th><th>操作</th></tr>
              </thead>
              <tbody>
                {list.data!.map(g => (
                  <tr key={g.id}>
                    <td data-label="客人名称">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span className="avatar sm">{g.name.charAt(0)}</span>
                        <span className="cell-main">{g.name}</span>
                      </div>
                    </td>
                    <td data-label="电话">{g.phone || '—'}</td>
                    <td data-label="证件号">{g.id_number || '—'}</td>
                    <td data-label="备注">
                      {g.notes
                        ? <span className="cell-sub" title={g.notes} style={{ display: 'inline-block', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>{g.notes}</span>
                        : <span className="muted">—</span>}
                    </td>
                    <td className="num" data-label="历史入住">{g.stay_count} 次</td>
                    <td className="num" data-label="累计消费">{fmtMoney(g.total_spend)}</td>
                    <td data-label="最近入住">{g.last_stay ? md(g.last_stay) : '—'}</td>
                    <td className="no-label"><button className="btn btn-quiet btn-sm" onClick={() => setDetail(g)}>查看档案</button></td>
                  </tr>
                ))}
                {list.data!.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 32 }}>暂无客户</td></tr>}
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
                  <div style={{ fontSize: 19, fontWeight: 600 }}>{g.name}</div>
                  <div className="hint" style={{ marginTop: 3 }}>手机 {g.phone || '—'}</div>
                </div>
                <button
                  className="btn btn-quiet btn-sm" style={{ marginLeft: 'auto' }}
                  onClick={() => setEditFor(g)}
                >编辑档案</button>
              </div>
              <div className="grid-3 mt-16">
                <div className="card stat" style={{ padding: '14px 16px' }}><div className="stat-label">历史入住</div><div className="stat-value" style={{ fontSize: 22 }}>{g.stay_count}</div></div>
                <div className="card stat" style={{ padding: '14px 16px' }}><div className="stat-label">累计消费</div><div className="stat-value" style={{ fontSize: 22 }}>{fmtMoney(g.total_spend)}</div></div>
                <div className="card stat" style={{ padding: '14px 16px' }}><div className="stat-label">最近入住</div><div className="stat-value" style={{ fontSize: 22 }}>{g.last_stay ? md(g.last_stay) : '—'}</div></div>
              </div>
              <div className="section-sub mt-24" style={{ marginBottom: 6 }}>身份信息</div>
              <div className="list" style={{ border: '1px solid var(--hairline-soft)', borderRadius: 14, overflow: 'hidden' }}>
                <div className="list-row" style={{ padding: '12px 16px' }}>
                  <span className="list-main"><span className="list-title" style={{ fontWeight: 500, fontSize: 14.5 }}>身份证</span></span>
                  <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>{g.id_number || '未登记'}</span>
                </div>
                <div className="list-row" style={{ padding: '12px 16px' }}>
                  <span className="list-main"><span className="list-title" style={{ fontWeight: 500, fontSize: 14.5 }}>手机号</span></span>
                  <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>{g.phone || '未登记'}</span>
                </div>
              </div>
              <div className="section-sub mt-24" style={{ marginBottom: 6 }}>备注</div>
              <p className="hint" style={{ whiteSpace: 'pre-wrap' }}>{g.notes || '暂无备注'}</p>
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
            </>
          )
        })()}
      </Drawer>

      {/* 编辑档案 */}
      <EditGuestDialog
        guest={editFor} busy={editMut.isPending} onClose={() => setEditFor(null)}
        onSubmit={(p) => editMut.mutate(p)}
      />

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
  const [notes, setNotes] = useState('')
  useEffect(() => { if (open) { setName(''); setPhone(''); setIdNo(''); setNotes('') } }, [open])
  return (
    <Dialog
      open={open} onClose={onClose} title="添加客户"
      foot={
        <>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={busy || !name.trim()}
                  onClick={() => {
                    if (!name.trim()) { toast('请输入姓名'); return }
                    onSubmit({ name, phone, id_number: idNo, vip_level: '', notes })
                  }}>保存</button>
        </>
      }
    >
      <Field label="姓名" required><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="请输入姓名" /></Field>
      <div className="form-row">
        <Field label="手机号" required><input className="input" value={phone} onChange={e => setPhone(e.target.value)} placeholder="11 位手机号" /></Field>
        <Field label="证件号"><input className="input" value={idNo} onChange={e => setIdNo(e.target.value)} placeholder="身份证 / 护照" /></Field>
      </div>
      <Field label="备注"><input className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="偏好、忌口等" /></Field>
    </Dialog>
  )
}

function EditGuestDialog({ guest, busy, onClose, onSubmit }: {
  guest: Guest | null; busy: boolean; onClose: () => void
  onSubmit: (p: { id: number; name: string; phone: string; id_number: string; notes: string }) => void
}) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [idNo, setIdNo] = useState('')
  const [notes, setNotes] = useState('')
  useEffect(() => {
    if (guest) { setName(guest.name); setPhone(guest.phone ?? ''); setIdNo(guest.id_number ?? ''); setNotes(guest.notes ?? '') }
  }, [guest])
  return (
    <Dialog
      open={guest !== null} onClose={onClose} title={`编辑档案 · ${guest?.name ?? ''}`}
      foot={
        <>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={busy || !name.trim()}
                  onClick={() => {
                    if (!guest) return
                    if (!name.trim()) { toast('请输入姓名'); return }
                    onSubmit({ id: guest.id, name, phone, id_number: idNo, notes })
                  }}>保存</button>
        </>
      }
    >
      <Field label="姓名" required><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="请输入姓名" /></Field>
      <div className="form-row">
        <Field label="手机号" required><input className="input" value={phone} onChange={e => setPhone(e.target.value)} placeholder="11 位手机号" /></Field>
        <Field label="证件号"><input className="input" value={idNo} onChange={e => setIdNo(e.target.value)} placeholder="身份证 / 护照" /></Field>
      </div>
      <Field label="备注" hint="偏好、忌口、熟客习惯等，仅本店员工可见。">
        <textarea className="input" rows={3} value={notes} onChange={e => setNotes(e.target.value)} placeholder="例如：喜欢高楼层、忌辣" />
      </Field>
    </Dialog>
  )
}
