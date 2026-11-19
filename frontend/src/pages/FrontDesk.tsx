import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  api, fmtMoney, md, todayIso,
  type Reservation,
} from '../api'
import { CheckInDialog } from '../dialogs'
import { Badge, Dialog, Field, PageHead, Segmented, Spinner, useToast } from '../ui'

export default function FrontDesk() {
  const toast = useToast()
  const qc = useQueryClient()
  const today = todayIso()
  const [tab, setTab] = useState<'arr' | 'in' | 'dep'>('arr')
  const [checkinRes, setCheckinRes] = useState<Reservation | null>(null)
  const [checkoutRes, setCheckoutRes] = useState<Reservation | null>(null)

  const arrivals = useQuery({
    queryKey: ['fd-arrivals', today],
    queryFn: () => api.get<Reservation[]>(`/api/reservations?date=${today}`),
  })
  const inhouse = useQuery({
    queryKey: ['fd-inhouse'],
    queryFn: () => api.get<Reservation[]>('/api/reservations?status=checked_in'),
  })
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['fd-arrivals'] })
    qc.invalidateQueries({ queryKey: ['fd-inhouse'] })
    qc.invalidateQueries({ queryKey: ['board'] })
    qc.invalidateQueries({ queryKey: ['dashboard'] })
    qc.invalidateQueries({ queryKey: ['housekeeping'] })
  }

  const mut = useMutation({
    mutationFn: (p: { path: string; body?: any; label: string }) => api.post(p.path, p.body ?? {}),
    onSuccess: (_d, p) => { toast(p.label); setCheckinRes(null); setCheckoutRes(null); invalidate() },
    onError: (e: any) => toast(e.message ?? '操作失败'),
  })

  const arrList = (arrivals.data ?? []).filter(r => r.status === 'pending' || r.status === 'confirmed')
  const inList = inhouse.data ?? []
  const depList = inList.filter(r => r.check_out === today)

  return (
    <>
      <PageHead
        title="前台工作台"
        desc={`今天 · 抵店 ${arrList.length} · 在住 ${inList.length} · 预离 ${depList.length}`}
      />

      <div className="filter-bar">
        <Segmented
          value={tab}
          options={[
            { key: 'arr', label: <>今日抵店 · {arrList.length}</> },
            { key: 'in', label: <>今日在住 · {inList.length}</> },
            { key: 'dep', label: <>今日离店 · {depList.length}</> },
          ]}
          onChange={setTab}
        />
      </div>

      {arrivals.isLoading || inhouse.isLoading ? <Spinner /> : (
        <>
          {tab === 'arr' && (
            <div className="card">
              <div className="list">
                {arrList.map(r => (
                  <div className="list-row" key={r.id}>
                    <span className="avatar sm">{r.guest_name.charAt(0)}</span>
                    <span className="list-main">
                      <span className="list-title">{r.guest_name} {r.vip_level && <Badge color="purple">{r.vip_level}</Badge>}</span>
                      <span className="list-sub">{r.code} · {r.room_type_name} · {md(r.check_in)} – {md(r.check_out)} · ¥{r.rate}</span>
                    </span>
                    <span className="list-side">
                      {r.status === 'pending' && <Badge color="orange">待确认</Badge>}
                      {r.status === 'confirmed' && <Badge color="green">已确认</Badge>}
                      {r.room_number && <span className="hint">已预留 {r.room_number}</span>}
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => setCheckinRes(r)}
                      >办理入住</button>
                    </span>
                  </div>
                ))}
                {arrList.length === 0 && <div className="empty">今日暂无抵店客人</div>}
              </div>
            </div>
          )}

          {tab === 'in' && (
            <div className="card">
              <div className="list">
                {inList.map(r => (
                  <div className="list-row" key={r.id}>
                    <span className="avatar sm">{r.guest_name.charAt(0)}</span>
                    <span className="list-main">
                      <span className="list-title">{r.guest_name} {r.vip_level && <Badge color="purple">{r.vip_level}</Badge>}</span>
                      <span className="list-sub">{r.room_number ?? '未分配'} · {md(r.check_in)} – {md(r.check_out)} {r.balance_due > 0 ? `· 挂账 ${fmtMoney(r.balance_due)}` : ''}</span>
                    </span>
                    <span className="list-side">
                      <button
                        className="btn btn-quiet btn-sm"
                        onClick={() => api.patch(`/api/reservations/${r.id}`, { check_out: addDay(r.check_out, 1) })
                          .then(() => { toast('已延住一天'); invalidate() })
                          .catch((e) => toast(e.message))}
                      >延住</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setCheckoutRes(r)}>退房结算</button>
                    </span>
                  </div>
                ))}
                {inList.length === 0 && <div className="empty">当前没有在住客人</div>}
              </div>
            </div>
          )}

          {tab === 'dep' && (
            <div className="card">
              <div className="list">
                {depList.map(r => (
                  <div className="list-row" key={r.id}>
                    <span className="avatar sm">{r.guest_name.charAt(0)}</span>
                    <span className="list-main">
                      <span className="list-title">{r.guest_name}</span>
                      <span className="list-sub">{r.room_number ?? ''} · {md(r.check_in)} – {md(r.check_out)} · {r.nights} 晚</span>
                    </span>
                    <span className="list-side">
                      {r.balance_due > 0
                        ? <span className="badge badge-red">未结清 {fmtMoney(r.balance_due)}</span>
                        : <span className="badge badge-gray">已结清</span>}
                      <button className="btn btn-primary btn-sm" onClick={() => setCheckoutRes(r)}>退房结算</button>
                    </span>
                  </div>
                ))}
                {depList.length === 0 && <div className="empty">今日暂无预离客人</div>}
              </div>
            </div>
          )}
        </>
      )}

      {/* 入住向导 */}
      {checkinRes && <CheckInDialog res={checkinRes} busy={mut.isPending} onClose={() => setCheckinRes(null)} onConfirm={(body, label) => mut.mutate({ path: `/api/reservations/${checkinRes.id}/check-in`, body, label })} />}

      {/* 退房结算 */}
      {checkoutRes && <CheckOutDialog res={checkoutRes} onClose={() => setCheckoutRes(null)} onConfirm={(body, label) => mut.mutate({ path: `/api/reservations/${checkoutRes.id}/check-out`, body, label })} />}
    </>
  )
}

function addDay(iso: string, n: number) {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d + n)
  const pad = (x: number) => (x < 10 ? '0' : '') + x
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
}

function CheckOutDialog({ res, onClose, onConfirm }: {
  res: Reservation
  onClose: () => void
  onConfirm: (body: any, label: string) => void
}) {
  const toast = useToast()
  const [method, setMethod] = useState('wechat')
  const folio = useQuery({
    queryKey: ['folio', res.id],
    queryFn: () => api.get<any>(`/api/reservations/${res.id}/folio`),
  })
  const data = folio.data
  const due = data?.balance_due ?? 0

  return (
    <Dialog
      open onClose={onClose}
      title={`退房结算 · ${res.room_number ?? ''}`}
      sub={`${res.guest_name} · ${md(res.check_in)} – ${md(res.check_out)} · 共 ${res.nights} 晚`}
      foot={
        <>
          <span className="hint" style={{ marginRight: 'auto' }}>操作人：当前登录账号</span>
          <button className="btn btn-ghost" onClick={onClose}>暂不结算</button>
          <button
            className="btn btn-primary"
            onClick={() => {
              const pays = due > 0 ? [{ method, amount: due }] : []
              onConfirm({ force: false, payments: pays }, due > 0 ? `已收款 ${fmtMoney(due)}，退房完成` : '退房完成，房态转空脏')
            }}
          >
            {due > 0 ? `确认收款 ${fmtMoney(due)}` : '确认退房'}
          </button>
        </>
      }
    >
      {data ? (
        <>
          {data.items.map((x: any) => (
            <div className="folio-line" key={x.id}>
              <span className="n">{x.description}</span>
              <span className="v">{fmtMoney(x.amount)}</span>
            </div>
          ))}
          <div className="folio-total">
            <div className="row"><span style={{ color: 'var(--text-secondary)' }}>消费合计</span><b style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(data.total_charge)}</b></div>
            <div className="row"><span style={{ color: 'var(--text-secondary)' }}>已收（含押金）</span><b style={{ fontVariantNumeric: 'tabular-nums' }}>− {fmtMoney(data.total_paid)}</b></div>
            <div className="row"><span>待收尾款</span><span className="due">{fmtMoney(Math.max(0, data.balance_due))}</span></div>
          </div>
          {due > 0 && (
            <Field label="收款方式">
              <select className="select" value={method} onChange={e => setMethod(e.target.value)}>
                <option value="wechat">微信</option><option value="alipay">支付宝</option>
                <option value="cash">现金</option><option value="card">刷卡</option>
              </select>
            </Field>
          )}
          <p className="hint warn">结算完成后，房态将转为空脏，并自动生成退房清洁任务。</p>
        </>
      ) : <Spinner />}
    </Dialog>
  )
}
