import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  CartesianGrid, Bar, BarChart, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { api, fmtMoney, todayIso } from '../api'
import { PageHead, Segmented, Spinner, useToast } from '../ui'

type Preset = '1' | '3' | '7' | '30' | 'month' | 'custom'

/* ---- 图表配色：一律走 CSS 变量，深浅主题自动跟随 ----
   Recharts 的 tick/contentStyle 需要真实色值，但 var() 在 SVG 属性里可用，
   在内联 style 里也由浏览器解析，因此不需要 useTheme 参与。 */
const AXIS_TICK = { fontSize: 11, fill: 'var(--text-tertiary)' }
const TOOLTIP_STYLE: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--hairline-soft)',
  borderRadius: 12,
  boxShadow: 'var(--shadow-pop)',
  fontSize: 12.5,
  padding: '8px 12px',
}
const TOOLTIP_LABEL: React.CSSProperties = { color: 'var(--text-secondary)', marginBottom: 4 }
const TOOLTIP_ITEM: React.CSSProperties = { color: 'var(--text-primary)' }

function shiftDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d + n)
  const pad = (x: number) => (x < 10 ? '0' : '') + x
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
}

export default function Reports() {
  const toast = useToast()
  const today = todayIso()
  const [preset, setPreset] = useState<Preset>('1')
  const [cFrom, setCFrom] = useState(shiftDays(today, -29))
  const [cTo, setCTo] = useState(today)
  const [applied, setApplied] = useState<{ from: string; to: string }>({ from: shiftDays(today, -29), to: today })

  const range = (() => {
    if (preset === '1') return { from: today, to: today, label: `统计周期：今天（${today}）` }
    if (preset === '3') return { from: shiftDays(today, -2), to: today, label: '统计周期：近 3 天' }
    if (preset === '7') return { from: shiftDays(today, -6), to: today, label: '统计周期：近 7 天' }
    if (preset === 'month') {
      const [y, m] = today.split('-').map(Number)
      return { from: `${y}-${String(m).padStart(2, '0')}-01`, to: today, label: `统计周期：本月（${y}年${m}月）` }
    }
    if (preset === 'custom') return { from: applied.from, to: applied.to, label: `统计周期：${applied.from} – ${applied.to}（自定义）` }
    return { from: shiftDays(today, -29), to: today, label: '统计周期：近 30 天' }
  })()

  const summary = useQuery({
    queryKey: ['rep-summary', range.from, range.to],
    queryFn: () => api.get<any>(`/api/reports/summary?from_date=${range.from}&to_date=${range.to}`),
  })
  const trends = useQuery({
    queryKey: ['rep-trends', range.from, range.to],
    queryFn: () => api.get<any[]>(`/api/reports/trends?from_date=${range.from}&to_date=${range.to}`),
  })
  const typeRows = useQuery({
    queryKey: ['rep-types', range.from, range.to],
    queryFn: () => api.get<any[]>(`/api/reports/room-types?from_date=${range.from}&to_date=${range.to}`),
  })

  const chartData = (trends.data ?? []).map(x => ({ ...x, label: x.date.slice(5) }))

  return (
    <>
      <PageHead
        title="经营报表"
        desc={range.label}
        actions={
          <>
            <Segmented
              value={preset}
              options={[
                { key: '1', label: '今天' }, { key: '3', label: '近 3 天' },
                { key: '7', label: '近 7 天' }, { key: '30', label: '近 30 天' },
                { key: 'month', label: '本月' }, { key: 'custom', label: '自定义' },
              ]}
              onChange={(v) => setPreset(v as Preset)}
            />
          </>
        }
      />

      {preset === 'custom' && (
        <div className="card card-pad mb-24">
          <div className="day-pick" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div>
              <div className="label" style={{ marginBottom: 6 }}>开始日期</div>
              <input className="input" type="date" value={cFrom} onChange={e => setCFrom(e.target.value)} />
            </div>
            <div>
              <div className="label" style={{ marginBottom: 6 }}>结束日期</div>
              <input className="input" type="date" value={cTo} onChange={e => setCTo(e.target.value)} />
            </div>
            <button
              className="btn btn-primary"
              onClick={() => {
                if (cFrom > cTo) { toast('开始日期不能晚于结束日期'); return }
                setApplied({ from: cFrom, to: cTo })
                toast('已应用自定义时间范围')
              }}
            >应用</button>
          </div>
        </div>
      )}

      {summary.isLoading || !summary.data ? <Spinner /> : (
        <div className="stats">
          <div className="card stat">
            <div className="stat-label">平均入住率</div>
            <div className="stat-value">{summary.data.occupancy}<span className="unit">%</span></div>
            <div className="stat-sub">范围内 {summary.data.days} 天 · {summary.data.rooms} 间客房</div>
          </div>
          <div className="card stat">
            <div className="stat-label">平均房价 ADR</div>
            <div className="stat-value">{fmtMoney(summary.data.adr)}</div>
            <div className="stat-sub">已售间夜 {summary.data.days} 天统计</div>
          </div>
          <div className="card stat">
            <div className="stat-label">每间可售房收入 RevPAR</div>
            <div className="stat-value">{fmtMoney(summary.data.revpar)}</div>
            <div className="stat-sub">可售间夜 {summary.data.days * summary.data.rooms}</div>
          </div>
          <div className="card stat">
            <div className="stat-label">期内总营收</div>
            <div className="stat-value">{fmtMoney(summary.data.revenue_total)}</div>
            <div className="stat-sub">房费 {fmtMoney(summary.data.revenue_room)} · 其他 {fmtMoney(summary.data.revenue_other)}</div>
          </div>
        </div>
      )}

      <div className="card mt-24">
        <div className="card-head">
          <div>
            <div className="card-title">入住率趋势</div>
            <div className="section-sub">每日入住率（%）</div>
          </div>
        </div>
        <div className="card-body" style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
              <CartesianGrid strokeDasharray="4 5" stroke="var(--hairline-soft)" />
              <XAxis dataKey="label" tick={AXIS_TICK} interval="preserveStartEnd" />
              <YAxis tick={AXIS_TICK} domain={[0, 100]} />
              <Tooltip
                formatter={(v: any) => `${v}%`}
                contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM}
              />
              {/* 1/3 天视图数据点少，单点不画线——必须显式画点，否则图形空白 */}
              <Line type="monotone" dataKey="occupancy" stroke="var(--accent)" strokeWidth={2.5} dot={chartData.length <= 3 ? { r: 3 } : false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card mt-16">
        <div className="card-head">
          <div>
            <div className="card-title">营收趋势</div>
            <div className="section-sub">每日营收（房费 / 其他收入）</div>
          </div>
        </div>
        <div className="card-body" style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
              <CartesianGrid strokeDasharray="4 5" stroke="var(--hairline-soft)" vertical={false} />
              <XAxis dataKey="label" tick={AXIS_TICK} interval="preserveStartEnd" />
              <YAxis tick={AXIS_TICK} />
              <Tooltip
                formatter={(v: any, k: any) => [fmtMoney(Number(v)), k === 'revenue_room' ? '房费收入' : '其他收入']}
                contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM}
              />
              {/* maxBarSize 防单点视图（今天）柱宽撑满整个分类带宽 */}
              <Bar dataKey="revenue_room" stackId="a" fill="var(--accent)" maxBarSize={48} radius={[4, 4, 0, 0]} />
              <Bar dataKey="revenue_other" stackId="a" fill="var(--accent)" opacity={0.35} maxBarSize={48} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card mt-16">
        <div className="card-head">
          <div className="card-title">房型经营对比</div>
          <div className="section-sub">{range.label.slice(5)}</div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>房型</th><th className="num">间数</th><th className="num">入住率</th><th className="num">平均房价</th><th className="num">营收</th></tr>
            </thead>
            <tbody>
              {(typeRows.data ?? []).map(t => (
                <tr key={t.room_type_id}>
                  <td data-label="房型" className="strong">{t.name}</td>
                  <td className="num" data-label="间数">{t.rooms}</td>
                  <td className="num" data-label="入住率">{t.occupancy}%</td>
                  <td className="num" data-label="平均房价">{fmtMoney(t.adr)}</td>
                  <td className="num" data-label="营收">{fmtMoney(t.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

    </>
  )
}

