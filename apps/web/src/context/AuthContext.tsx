import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react'

export interface UserProfile {
  id: number
  email: string
  role: 'admin' | 'developer' | 'viewer'
  totpEnabled: boolean
}

interface AuthContextValue {
  token: string | null
  user: UserProfile | null
  login: (token: string) => Promise<void>
  logout: () => void
  isAdmin: boolean
  canWrite: boolean
}

const AuthContext = createContext<AuthContextValue | null>(null)

const TOKEN_KEY = 'orchestrator_token'
const USER_KEY  = 'orchestrator_user'

async function fetchMe(token: string): Promise<UserProfile | null> {
  try {
    const res = await fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!res.ok) return null
    const data = await res.json()
    return {
      id: data.id,
      email: data.email,
      role: (data.role ?? 'admin') as UserProfile['role'],
      totpEnabled: data.totpEnabled ?? false
    }
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY))
  const [user,  setUser]  = useState<UserProfile | null>(() => {
    try {
      const stored = localStorage.getItem(USER_KEY)
      return stored ? JSON.parse(stored) : null
    } catch {
      return null
    }
  })

  // On mount, refresh user profile if we have a token
  useEffect(() => {
    if (token && !user) {
      fetchMe(token).then((u) => {
        if (u) {
          setUser(u)
          localStorage.setItem(USER_KEY, JSON.stringify(u))
        }
      })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const login = useCallback(async (newToken: string) => {
    localStorage.setItem(TOKEN_KEY, newToken)
    setToken(newToken)
    const profile = await fetchMe(newToken)
    if (profile) {
      setUser(profile)
      localStorage.setItem(USER_KEY, JSON.stringify(profile))
    }
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
    setToken(null)
    setUser(null)
  }, [])

  const isAdmin  = user?.role === 'admin'
  const canWrite = user?.role === 'admin' || user?.role === 'developer'

  return (
    <AuthContext.Provider value={{ token, user, login, logout, isAdmin, canWrite }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
