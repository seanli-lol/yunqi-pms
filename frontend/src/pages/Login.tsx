import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Monitor, Moon, Sun } from 'lucide-react'
import { api, type Hotel } from '../api'
import { useAuth } from '../auth'
import { SliderCaptcha } from '../captcha'
import { useTheme, type ThemeMode } from '../theme'
import { Segmented, useToast } from '../ui'

const THEME_ORDER: ThemeMode[] = ['light', 'dark', 'system']
const THEME_LABEL: Record<ThemeMode, string> = { light: '浅色', dark: '深色', system: '跟随系统' }
const THEME_ICON = { light: Sun, dark: Moon, system: Monitor }

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
  // 滑块验证码：captchaEnabled 由组件回报（后端可关闭），captchaToken 通过后一次性票据
  const [captchaEnabled, setCaptchaEnabled] = useState(true)
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const [captchaKey, setCaptchaKey] = useState(0)
  // 主题：登录页无侧栏，用右上角浮动圆钮三态循环（与设计稿 login.html 一致）
  const { mode: themeMode, setMode: setThemeMode } = useTheme()
  const ThemeIcon = THEME_ICON[themeMode]
  const cycleTheme = () => {
    setThemeMode(THEME_ORDER[(THEME_ORDER.indexOf(themeMode) + 1) % THEME_ORDER.length])
  }

  useEffect(() => {
    api.get('/api/hotels/public', { skipHotel: true }).then((hs: Hotel[]) => {
      setHotels(hs)
      if (hs.length) setHotelId(hs[0].id)
    }).catch(() => setErr('无法获取酒店列表，请确认后端已启动'))
  }, [])

  const submit = async () => {
    if (captchaEnabled && !captchaToken) {
      setErr('请先完成滑块验证')
      return
    }
    setBusy(true)
    setErr('')
    try {
      await login(mode === 'hotel' ? hotelId : null, username, password, captchaToken)
      toast('登录成功')
      // 平台管理员进入设置（酒店管理）；员工进入仪表盘
      const me = JSON.parse(localStorage.getItem('pms_user') || '{}')
      setTimeout(() => nav(me.role === 'platform_admin' ? '/settings' : '/'), 400)
    } catch (e: any) {
      setErr(e.message ?? '登录失败')
      setBusy(false)
      // 票据一次性：失败后必须重新滑动
      setCaptchaToken(null)
      setCaptchaKey(k => k + 1)
    }
  }

  return (
    <div className="auth-body" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg-secondary)', padding: 24 }}>
      <button
        type="button"
        className="theme-fab"
        title={`外观 · ${THEME_LABEL[themeMode]}`}
        aria-label={`外观 · ${THEME_LABEL[themeMode]}（点击切换）`}
        onClick={cycleTheme}
      >
        <ThemeIcon />
      </button>
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
          <SliderCaptcha
            resetKey={captchaKey}
            onVerified={setCaptchaToken}
            onEnabled={setCaptchaEnabled}
          />
          {err && <p className="hint warn" style={{ marginBottom: 12 }}>{err}</p>}
          <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy || (captchaEnabled && !captchaToken)}>
            {busy ? '登录中…' : captchaEnabled && !captchaToken ? '请先完成滑块验证' : '登录'}
          </button>
        </form>

        {import.meta.env.VITE_DEMO_HINT !== 'off' && (
          <p className="hint" style={{ marginTop: 20, lineHeight: 1.6 }}>
            演示账号：员工 zhouqi / 123456（任选酒店）<br />平台管理员 admin / 123456
          </p>
        )}
      </main>
    </div>
  )
}
