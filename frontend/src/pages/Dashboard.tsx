import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, fmtMoney, maskPhone, type DashData } from '../api'
import { Badge, PageHead, Spinner, Stat, useToast } from '../ui'

export default function Dashboard() {
  const nav = useNavigate()
  const toast = useToast()
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashData>('/api/dashboard'),
    refetchInterval: 30_000,
  })

  if (isLoading || !data) return <Spinner />

  const weekday = ['日', '一', '二', '三', '四', '五', '六'][new Date().getDay()]

  return (
    <>
      <PageHead
        title="仪表盘"
        desc={`${data.today_label} 星期${weekday} · 云栖酒店`}
        actions={
          <>
            <button className="btn btn-ghost" onClick={() => nav('/reports')}>经营报表</button>
            <button className="btn btn-primary" onClick={() => nav('/reservations')}>新建预订</button>
          </>
        }
      />

      <div className="stats">
        <Stat label="今日入住率" value={data.occupancy_today} unit="%" sub={<>在住 <b>{data.occupied}</b> ／ 总客房 <b>{data.total_rooms}</b> 间</>} />
        <Stat label="今日抵店" value={data.arrivals} sub={<><b>{data.arrivals_ready}</b> 位可办理入住</>} />
        <Stat label="今日离店" value={data.departures} sub={<><b className="down">{data.unpaid_count}</b> 笔账单未结清</>} />
        <Stat label="今日营收" value={fmtMoney(data.revenue_today)} sub={<>房费 {fmtMoney(data.revenue_room)} · 其他 {fmtMoney(data.revenue_other)}</>} />
      </div>

      <div className="grid-2 mt-16">
        <div className="card">
          <div className="card-head">
            <div className="card-title">营收概览</div>
            <a className="card-link" onClick={() => nav('/billing')} style={{ cursor: 'pointer' }}>账务明细</a>
          </div>
          <div className="card-body">
            <div className="stat-label">今日营收</div>
            <div className="stat-value" style={{ fontSize: 40 }}>{fmtMoney(data.revenue_today)}</div>
            <div className="mt-16">
              <div className="flex-between" style={{ fontSize: 13.5 }}>
                <span style={{ color: 'var(--text-secondary)' }}>房费收入</span>
                <b style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(data.revenue_room)}</b>
              </div>
              <div style={{ height: 6, borderRadius: 100, background: 'var(--bg-secondary)', marginTop: 8 }}>
                <div style={{ width: `${data.revenue_today ? data.revenue_room / data.revenue_today * 100 : 0}%`, height: '100%', borderRadius: 100, background: 'var(--accent)' }} />
              </div>
            </div>
            <div className="mt-8">
              <div className="flex-between" style={{ fontSize: 13.5 }}>
                <span style={{ color: 'var(--text-secondary)' }}>其他收入</span>
                <b style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(data.revenue_other)}</b>
              </div>
              <div style={{ height: 6, borderRadius: 100, background: 'var(--bg-secondary)', marginTop: 8 }}>
                <div style={{ width: `${data.revenue_today ? data.revenue_other / data.revenue_today * 100 : 0}%`, height: '100%', borderRadius: 100, background: 'var(--success)' }} />
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><div className="card-title">今日待办</div></div>
          <div className="list">
            {data.pending_confirm > 0 && (
              <a className="list-row" style={{ cursor: 'pointer' }} onClick={() => nav('/reservations', { state: { status: 'pending' } })}>
                <span className="dot dot-orange" />
                <span className="list-main">
                  <span className="list-title">{data.pending_confirm} 单预订待确认</span>
                  <span className="list-sub">在预订管理中逐单确认</span>
                </span>
                <span className="list-side muted">›</span>
              </a>
            )}
            {data.unpaid_count > 0 && (
              <a className="list-row" style={{ cursor: 'pointer' }} onClick={() => nav('/billing')}>
                <span className="dot dot-red" />
                <span className="list-main">
                  <span className="list-title">{data.unpaid_count} 笔账单未结清</span>
                  <span className="list-sub">应收 {fmtMoney(data.unpaid_amount)}</span>
                </span>
                <span className="list-side muted">›</span>
              </a>
            )}
            {data.maintenance_count > 0 && (
              <a className="list-row" style={{ cursor: 'pointer' }} onClick={() => nav('/rooms')}>
                <span className="dot dot-red" />
                <span className="list-main">
                  <span className="list-title">{data.maintenance_count} 间客房维修中</span>
                  <span className="list-sub">维修完成后在房态盘点「设净」恢复可售</span>
                </span>
                <span className="list-side muted">›</span>
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="grid-2 mt-16">
        <div className="card">
          <div className="card-head">
            <div className="card-title">今日抵店 <span className="muted" style={{ fontWeight: 500, fontSize: 14 }}>{data.arrivals}</span></div>
            <a className="card-link" style={{ cursor: 'pointer' }} onClick={() => nav('/front-desk')}>查看全部</a>
          </div>
          <div className="list">
            {data.arrival_items.map(x => (
              <div className="list-row" key={x.id}>
                <span className="avatar sm">{x.guest_name.charAt(0)}</span>
                <span className="list-main">
                  <span className="list-title">
                    {x.guest_name}
                    {x.vip_level && <Badge color="purple" >{x.vip_level}</Badge>}
                  </span>
                  <span className="list-sub">{x.code} · {x.room_type_name} · {x.check_in.slice(5)} – {x.check_out.slice(5)} · ¥{x.rate}</span>
                </span>
                <span className="list-side">
                  <button className="btn btn-primary btn-sm" onClick={() => nav('/front-desk')}>办理入住</button>
                </span>
              </div>
            ))}
            {data.arrival_items.length === 0 && <div className="empty">今日暂无抵店客人</div>}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div className="card-title">今日离店 <span className="muted" style={{ fontWeight: 500, fontSize: 14 }}>{data.departures}</span></div>
            <a className="card-link" style={{ cursor: 'pointer' }} onClick={() => nav('/front-desk')}>查看全部</a>
          </div>
          <div className="list">
            {data.departure_items.map(x => (
              <div className="list-row" key={x.id}>
                <span className="avatar sm">{x.guest_name.charAt(0)}</span>
                <span className="list-main">
                  <span className="list-title">{x.guest_name}</span>
                  <span className="list-sub">{x.room_number} · {x.check_in.slice(5)} – {x.check_out.slice(5)} · {x.nights} 晚</span>
                </span>
                <span className="list-side">
                  {x.balance_due > 0
                    ? <Badge color="red">未结清 {fmtMoney(x.balance_due)}</Badge>
                    : <Badge color="gray">已结清</Badge>}
                  <button className="btn btn-ghost btn-sm" onClick={() => nav('/front-desk')}>退房结算</button>
                </span>
              </div>
            ))}
            {data.departure_items.length === 0 && <div className="empty">今日暂无预离客人</div>}
          </div>
        </div>
      </div>
    </>
  )
}
