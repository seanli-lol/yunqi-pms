import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, fmtMoney, md, payMethodLabel, usePayMethods, type Reservation } from '../api'
import { Badge, Dialog, Drawer, Field, PageHead, Spinner, useToast } from '../ui'

export default function Billing() {
  const toast = useToast()
  const qc = useQueryClient()
  const [detail, setDetail] = useState<Reservation | null>(null)
  const [payOpen, setPayOpen] = useState(false)
  // 收款方式来自设置（各店可配置）；默认值同步进 state，不能只靠 select 渲染兜底
  const pms = usePayMethods()
  const [method, setMethod] = useState('')
  useEffect(() => {
    const codes = pms.data?.map(m => m.code) ?? []
    if (codes.length && !codes.includes(method)) setMethod(codes[0])
  }, [pms.data, method])

  const list = useQuery({
    queryKey: ['billing-list'],
    queryFn: () => api.get<Reservation[]>('/api/reservations?status=checked_in')
      .then(async (inhouse: Reservation[]) => {
        const out = await api.get<Reservation[]>('/api/reservations?status=checked_out')
        return [...inhouse, ...out]
      }),
  })
  const folio = useQuery({
    queryKey: ['folio', detail?.id],
    enabled: detail !== null,
    queryFn: () => api.get<any>(`/api/reservations/${detail!.id}/folio`),
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['billing-list'] })
    qc.invalidateQueries({ queryKey: ['folio'] })
    qc.invalidateQueries({ queryKey: ['dashboard'] })
  }

  const payMut = useMutation({
    mutationFn: (p: { id: number; method: string; amount: number }) =>
      api.post(`/api/reservations/${p.id}/payments`, { method: p.method, amount: p.amount }),
    onSuccess: () => { toast('收款成功'); setPayOpen(false); invalidate() },
    onError: (e: any) => toast(e.message ?? '收款失败'),
  })

  const rows = list.data ?? []
  const unpaid = rows.filter(r => r.balance_due > 0)
  const unpaidAmount = unpaid.reduce((s, r) => s + r.balance_due, 0)
  const inhouse = rows.filter(r => r.status === 'checked_in')

  return (
    <>
      <PageHead
        title="账务"
        desc={`未结清 ${unpaid.length} 笔 · 应收 ${fmtMoney(unpaidAmount)}`}
      />

      <div className="stats">
        <div className="card stat">
          <div className="stat-label">在住挂账</div>
          <div className="stat-value">{inhouse.length}<span className="unit">间</span></div>
          <div className="stat-sub">在住账单实时更新</div>
        </div>
        <div className="card stat">
          <div className="stat-label">未结清账单</div>
          <div className="stat-value" style={{ color: unpaid.length ? 'var(--danger-deep)' : undefined }}>{unpaid.length}<span className="unit">笔</span></div>
          <div className="stat-sub">应收 <b className="down">{fmtMoney(unpaidAmount)}</b></div>
        </div>
        <div className="card stat" style={{ gridColumn: 'span 2' }}>
          <div className="stat-label">未结清明细</div>
          <div className="stat-sub" style={{ marginTop: 10, fontSize: 13.5 }}>
            {unpaid.length === 0 && '所有账单均已结清 ✓'}
            {unpaid.slice(0, 3).map(r => (
              <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                <span>{r.guest_name} · {r.room_number ?? '未分配'}</span>
                <b style={{ color: 'var(--danger-deep)' }}>{fmtMoney(r.balance_due)}</b>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card mt-24">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>预订号</th><th>客人</th><th>房型 / 房号</th><th>住期</th>
                <th className="num">状态</th><th className="num">未结</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td data-label="预订号" className="strong">{r.code}</td>
                  <td data-label="客人">
                    <div className="cell-main">{r.guest_name} {r.vip_level && <span className="badge badge-purple" style={{ marginLeft: 4 }}>{r.vip_level}</span>}</div>
                    <div className="cell-sub">{md(r.check_in)} – {md(r.check_out)} · {r.nights} 晚</div>
                  </td>
                  <td data-label="房型 / 房号">{r.room_type_name} · {r.room_number ?? '未分配'}</td>
                  <td data-label="住期">{r.check_in.slice(5)} – {r.check_out.slice(5)}</td>
                  <td data-label="状态">
                    {r.status === 'checked_in'
                      ? <Badge color="blue">在住中</Badge>
                      : r.balance_due > 0 ? <Badge color="red">未结清</Badge> : <Badge color="green">已结清</Badge>}
                  </td>
                  <td className="num" data-label="未结">
                    {r.balance_due > 0 ? <b style={{ color: 'var(--danger-deep)' }}>{fmtMoney(r.balance_due)}</b> : fmtMoney(0)}
                  </td>
                  <td className="no-label">
                    <button className="btn btn-primary btn-sm" onClick={() => setDetail(r)}>查看明细</button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 32 }}>暂无账单</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* 账单抽屉 */}
      <Drawer
        open={detail !== null} onClose={() => setDetail(null)}
        title="账单明细"
        sub={detail ? `${detail.code} · ${detail.guest_name} · ${detail.room_number ?? '未分配'}` : ''}
        foot={
          detail && folio.data && folio.data.balance_due > 0 ? (
            <>
              <button className="btn btn-primary" onClick={() => setPayOpen(true)}>立即收款 {fmtMoney(folio.data.balance_due)}</button>
            </>
          ) : null
        }
      >
        {folio.isLoading || !folio.data ? <Spinner /> : (
          <>
            <div className="section-sub" style={{ marginBottom: 6 }}>消费项目</div>
            <div className="list" style={{ border: '1px solid var(--hairline-soft)', borderRadius: 14, overflow: 'hidden' }}>
              {folio.data.items.map((x: any) => (
                <div className="list-row" style={{ padding: '12px 16px' }} key={x.id}>
                  <span className="list-main">
                    <span className="list-title" style={{ fontWeight: 500, fontSize: 14.5 }}>{x.description}</span>
                    <span className="list-sub">{x.created_at.slice(5, 16).replace('T', ' ')} · {x.operator}</span>
                  </span>
                  <span className="list-amount">{fmtMoney(x.amount)}</span>
                </div>
              ))}
            </div>
            <div className="flex-between mt-16" style={{ fontSize: 14.5 }}>
              <span style={{ color: 'var(--text-secondary)' }}>消费合计</span>
              <b style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(folio.data.total_charge)}</b>
            </div>
            <div className="flex-between mt-8" style={{ fontSize: 14.5 }}>
              <span style={{ color: 'var(--text-secondary)' }}>已收（含押金）</span>
              <b style={{ fontVariantNumeric: 'tabular-nums' }}>− {fmtMoney(folio.data.total_paid)}</b>
            </div>
            <div className="flex-between mt-16" style={{ background: folio.data.balance_due > 0 ? 'var(--danger-tint)' : 'var(--success-tint)', borderRadius: 12, padding: '14px 16px', fontSize: 15 }}>
              <span style={{ color: folio.data.balance_due > 0 ? 'var(--danger-deep)' : 'var(--success-deep)' }}>
                {folio.data.balance_due > 0 ? '应收尾款' : '已结清'}
              </span>
              <b style={{ color: folio.data.balance_due > 0 ? 'var(--danger-deep)' : 'var(--success-deep)', fontVariantNumeric: 'tabular-nums', fontSize: 18 }}>
                {folio.data.balance_due > 0 ? fmtMoney(folio.data.balance_due) : '✓'}
              </b>
            </div>

            <div className="section-sub mt-24" style={{ marginBottom: 6 }}>收款记录</div>
            <div className="list" style={{ border: '1px solid var(--hairline-soft)', borderRadius: 14, overflow: 'hidden' }}>
              {folio.data.payments.map((x: any) => (
                <div className="list-row" style={{ padding: '12px 16px' }} key={x.id}>
                  <span className="list-main">
                    <span className="list-title" style={{ fontWeight: 500, fontSize: 14.5 }}>{payMethodLabel(pms.data, x.method)}</span>
                    <span className="list-sub">{x.created_at.slice(5, 16).replace('T', ' ')} · {x.operator}{x.remark ? ` · ${x.remark}` : ''}</span>
                  </span>
                  <span className="list-amount">{fmtMoney(x.amount)}</span>
                </div>
              ))}
              {folio.data.payments.length === 0 && <div className="empty">暂无收款记录</div>}
            </div>
          </>
        )}
      </Drawer>

      {/* 收款对话框 */}
      <Dialog
        open={payOpen} onClose={() => setPayOpen(false)}
        title="立即收款"
        sub={detail ? `${detail.guest_name} · ${detail.code}` : ''}
        foot={
          <>
            <button className="btn btn-ghost" onClick={() => setPayOpen(false)}>取消</button>
            <button
              className="btn btn-primary"
              disabled={payMut.isPending || !folio.data}
              onClick={() => payMut.mutate({ id: detail!.id, method, amount: folio.data.balance_due })}
            >确认收款 {folio.data ? fmtMoney(folio.data.balance_due) : ''}</button>
          </>
        }
      >
        <Field label="收款方式">
          <select className="select" value={method} onChange={e => setMethod(e.target.value)}>
            {(pms.data ?? []).map(m => <option key={m.code} value={m.code}>{m.name}</option>)}
          </select>
        </Field>
      </Dialog>
    </>
  )
}
