import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type Hotel } from '../api'
import { useAuth } from '../auth'
import { Segmented, useToast } from '../ui'

export default function Login() {
  const nav = useNavigate()
  const toast = useToast()
  const { login } = useAuth()
  const [mode, setMode] = useState<'hotel' | 'admin'>('hotel')
  const [hotels, setHotels] = useState<Hotel[]>([])
  const [hotelId, setHotelId] = useState<number | null>(null)
  const [username, setUsername] = useState('zhouqi')
  const [password, setPassword] = useState('123456')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    api.get('/api/hotels/public', { skipHotel: true }).then((hs: Hotel[]) => {
      setHotels(hs)
      if (hs.length) setHotelId(hs[0].id)
    }).catch(() => setErr('无法获取酒店列表，请确认后端已启动'))
  }, [])

  const submit = async () => {
    setBusy(true)
    setErr('')
    try {
      await login(mode === 'hotel' ? hotelId : null, username, password)
      toast('登录成功')
      // 平台管理员进入设置（酒店管理）；员工进入仪表盘
      const me = JSON.parse(localStorage.getItem('pms_user') || '{}')
      setTimeout(() => nav(me.role === 'platform_admin' ? '/settings' : '/'), 400)
    } catch (e: any) {
      setErr(e.message ?? '登录失败')
      setBusy(false)
    }
  }

  return (
    <div className="auth-body" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg-secondary)', padding: 24 }}>
      <main className="card" style={{ width: 'min(420px, 100%)', padding: '40px 36px 32px', textAlign: 'center', background: 'var(--bg)', borderRadius: 'var(--radius-card)', border: '1px solid var(--hairline-soft)' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
          <span className="brand-mark" style={{ width: 44, height: 44, borderRadius: 12, fontSize: 19 }}>云</span>
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em' }}>登录云栖 PMS</h1>
        <p style={{ marginTop: 6, fontSize: 14, color: 'var(--text-secondary)' }}>各酒店数据相互隔离 · 请登录你所属的酒店</p>

        <div style={{ marginTop: 22, display: 'flex', justifyContent: 'center' }}>
          <Segmented
            value={mode}
            options={[{ key: 'hotel', label: '酒店员工' }, { key: 'admin', label: '平台管理员' }]}
            onChange={(m) => { setMode(m); setUsername(m === 'admin' ? 'admin' : 'zhouqi') }}
          />
        </div>

        {mode === 'admin' && (
          <div style={{ background: 'var(--bg-secondary)', borderRadius: 12, padding: '12px 14px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, textAlign: 'left', margin: '18px 0 0' }}>
            平台管理员不隶属于任何单店，无需填写酒店名称；登录后可新增酒店、为各酒店配置员工账号，并查看全部门店数据。
          </div>
        )}

        <form style={{ marginTop: 22, textAlign: 'left' }} onSubmit={(e) => { e.preventDefault(); submit() }}>
          {mode === 'hotel' && (
            <div className="field">
              <label className="label">酒店</label>
              <select className="select" value={hotelId ?? ''} onChange={e => setHotelId(Number(e.target.value))}>
                {hotels.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
              </select>
              <span className="hint">登录后仅能查看和操作所选酒店的数据。</span>
            </div>
          )}
          <div className="field">
            <label className="label">账号</label>
            <input className="input" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" />
          </div>
          <div className="field">
            <label className="label">密码</label>
            <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" />
          </div>
          {err && <p className="hint warn" style={{ marginBottom: 12 }}>{err}</p>}
          <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy}>
            {busy ? '登录中…' : '登录'}
          </button>
        </form>

        <p className="hint" style={{ marginTop: 20, lineHeight: 1.6 }}>
          演示账号：员工 zhouqi / 123456（任选酒店）<br />平台管理员 admin / 123456
        </p>
      </main>
    </div>
  )
}
