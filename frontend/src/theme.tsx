import { createContext, useCallback, useContext, useEffect, useState } from 'react'

/**
 * 深浅主题状态。
 * 契约与 design/prototype/theme.js 一致：
 * - 偏好存 localStorage.pms_theme ∈ 'light' | 'dark' | 'system'（缺省 system）
 * - <html data-theme> 永远写具体值 light|dark，CSS 只认这一个选择器，
 *   因此 index.css 里只有一份深色令牌块，不必再复制 prefers-color-scheme 版本
 */
export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const KEY = 'pms_theme'
const DARK_MQ = '(prefers-color-scheme: dark)'

function readMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark') return v
  } catch { /* 隐私模式忽略 */ }
  return 'system'
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.(DARK_MQ).matches
}

function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode === 'light' || mode === 'dark') return mode
  return systemPrefersDark() ? 'dark' : 'light'
}

interface ThemeState {
  mode: ThemeMode
  resolved: ResolvedTheme
  setMode: (m: ThemeMode) => void
}

const Ctx = createContext<ThemeState>(null as any)

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // 懒初始化读 localStorage（与 auth.tsx / AppShell.tsx 的 pms_rail 同一套写法）
  const [mode, setModeState] = useState<ThemeMode>(readMode)
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(readMode()))

  // 写入 <html data-theme> + 记住偏好
  const apply = useCallback((next: ThemeMode) => {
    const r = resolve(next)
    document.documentElement.setAttribute('data-theme', r)
    try { localStorage.setItem(KEY, next) } catch { /* 忽略 */ }
    setModeState(next)
    setResolved(r)
  }, [])

  const setMode = useCallback((next: ThemeMode) => apply(next), [apply])

  // 启动时按当前偏好落地（index.html 的内联脚本已先写一次防闪白，这里保证一致）
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolve(mode))
    setResolved(resolve(mode))
    // 只在挂载时跑一次：后续变更由 setMode 直接写
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // system 模式跟随 OS 深浅色实时切换
  useEffect(() => {
    if (mode !== 'system') return
    const mq = window.matchMedia?.(DARK_MQ)
    if (!mq) return
    const onChange = () => {
      const r = mq.matches ? 'dark' : 'light'
      document.documentElement.setAttribute('data-theme', r)
      setResolved(r)
    }
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [mode])

  return <Ctx.Provider value={{ mode, resolved, setMode }}>{children}</Ctx.Provider>
}

export function useTheme() {
  return useContext(Ctx)
}
