import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useAuth } from '../auth'
import { SliderCaptcha } from '../captcha'
import { useTheme, type ThemeMode } from '../theme'
import { useToast } from '../ui'

const THEME_ORDER: ThemeMode[] = ['light', 'dark', 'system']
const THEME_LABEL: Record<ThemeMode, string> = { light: '浅色', dark: '深色', system: '跟随系统' }
const THEME_ICON = { light: Sun, dark: Moon, system: Monitor }

export default function Login() {
  const nav = useNavigate()
  const toast = useToast()
  const { login } = useAuth()
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

  const submit = async () => {
    if (captchaEnabled && !captchaToken) {
      setErr('请先完成滑块验证')
      return
    }
    setBusy(true)
    setErr('')
    try {
      // 账号密码直登：员工默认进主店，绑定多店的账号在顶栏切换（不再选店，无管理员入口）
      await login(username, password, captchaToken)
      toast('登录成功')
      setTimeout(() => nav('/'), 400)
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
        <p style={{ marginTop: 6, fontSize: 14, color: 'var(--text-secondary)' }}>账号密码直接登录 · 绑定多店的账号登录后可在顶栏切换酒店</p>

        <form style={{ marginTop: 22, textAlign: 'left' }} onSubmit={(e) => { e.preventDefault(); submit() }}>
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
            演示账号：员工 zhouqi / 123456<br />超级管理员 admin / 123456（登录后右上角可切换酒店）
          </p>
        )}
      </main>
    </div>
  )
}
