import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import {
  api, clearAuthStorage, getRefreshToken, setAuthToken, setHotelResolver,
  setRefreshToken, setTokenExpiry, type LoginUser,
} from './api'

interface AuthState {
  user: LoginUser | null
  /** 平台管理员当前操作的酒店；员工为固定本店 */
  activeHotelId: number | null
  activeHotelName: string | null
  login: (hotelId: number | null, username: string, password: string, captchaToken?: string | null) => Promise<void>
  logout: () => void
  setActiveHotel: (id: number, name: string) => void
}

const Ctx = createContext<AuthState>(null as any)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<LoginUser | null>(() => {
    try {
      const raw = localStorage.getItem('pms_user')
      return raw ? (JSON.parse(raw) as LoginUser) : null
    } catch { return null }
  })
  const [active, setActive] = useState<{ id: number | null; name: string | null }>(() => {
    try {
      const raw = localStorage.getItem('pms_active_hotel')
      if (raw) return JSON.parse(raw) as { id: number | null; name: string | null }
    } catch { /* ignore */ }
    return { id: null, name: null }
  })

  const applyUser = useCallback((u: LoginUser | null) => {
    setUser(u)
    if (u) localStorage.setItem('pms_user', JSON.stringify(u))
    else localStorage.removeItem('pms_user')
  }, [])

  const login = useCallback(async (hotelId: number | null, username: string, password: string, captchaToken?: string | null) => {
    const body: any = { username, password }
    if (hotelId !== null) body.hotel_id = hotelId
    if (captchaToken) body.captcha_token = captchaToken
    const r = await api.post('/api/auth/login', body, { skipHotel: true })
    setAuthToken(r.token)
    setRefreshToken(r.refresh_token)
    setTokenExpiry(Date.now() + r.expires_in * 1000)
    applyUser(r.user)
    const aid = r.user.hotel_id
    const aname = r.user.hotel_name
    setActive({ id: aid, name: aname })
    localStorage.setItem('pms_active_hotel', JSON.stringify({ id: aid, name: aname }))
    setHotelResolver(() => aid)
  }, [applyUser])

  const logout = useCallback(() => {
    // 顺手在服务端吊销刷新令牌（失败不影响本地退出）
    const rt = getRefreshToken()
    if (rt) {
      api.post('/api/auth/logout', { refresh_token: rt }, { skipHotel: true }).catch(() => {})
    }
    clearAuthStorage()
    applyUser(null)
    setActive({ id: null, name: null })
    setHotelResolver(() => null)
    localStorage.removeItem('pms_active_hotel')
  }, [applyUser])

  const setActiveHotel = useCallback((id: number, name: string) => {
    setActive({ id, name })
    localStorage.setItem('pms_active_hotel', JSON.stringify({ id, name }))
    setHotelResolver(() => id)
  }, [])

  // 启动时恢复 resolver（副作用放 useEffect，避免渲染期副作用）
  useEffect(() => {
    if (user && active.id !== null && active.id !== undefined) {
      setHotelResolver(() => active.id)
    } else if (!user) {
      setHotelResolver(() => null)
    }
  }, [user, active.id])

  return (
    <Ctx.Provider value={{ user, activeHotelId: active.id, activeHotelName: active.name, login, logout, setActiveHotel }}>
      {children}
    </Ctx.Provider>
  )
}

export function useAuth() {
  return useContext(Ctx)
}
