import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { initTelegram, isTelegram } from '../lib/telegram'
import {
  login,
  getMe,
  getConfig,
  loginWithWidget,
  devLogin,
  setSessionToken,
  getSessionToken,
  clearSessionToken,
  type TelegramWidgetData,
} from '../lib/api'

interface User {
  telegram_id: number
  username: string
  first_name: string
  photo_url?: string
  balance: number
}

interface AppContextValue {
  user: User | null
  config: Record<string, unknown> | null
  loading: boolean
  error: string | null
  needsLogin: boolean
  setBalance: (newBalance: number) => void
  loginWithWidgetData: (data: TelegramWidgetData) => Promise<void>
  loginAsDev: () => Promise<void>
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [config, setConfig] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [needsLogin, setNeedsLogin] = useState(false)

  useEffect(() => {
    async function initialize() {
      initTelegram()

      if (isTelegram()) {
        try {
          const [loginRes, configRes] = await Promise.all([login(), getConfig()])
          setUser(loginRes.user)
          setConfig(configRes)
        } catch {
          setError('Failed to connect to the server.')
        } finally {
          setLoading(false)
        }
        return
      }

      // Not inside Telegram — check for stored session token
      const sessionToken = getSessionToken()
      if (sessionToken) {
        try {
          const [meRes, configRes] = await Promise.all([getMe(), getConfig()])
          setUser(meRes.user)
          setConfig(configRes)
        } catch {
          // Token is invalid or expired
          clearSessionToken()
          setNeedsLogin(true)
        } finally {
          setLoading(false)
        }
        return
      }

      // No session — show login screen
      setNeedsLogin(true)
      setLoading(false)
    }

    initialize()
  }, [])

  function setBalance(newBalance: number) {
    setUser((prev) => (prev ? { ...prev, balance: newBalance } : prev))
  }

  async function loginWithWidgetData(data: TelegramWidgetData): Promise<void> {
    const response = await loginWithWidget(data)
    setSessionToken(response.token)
    const configRes = await getConfig()
    setUser(response.user)
    setConfig(configRes)
    setNeedsLogin(false)
  }

  async function loginAsDev(): Promise<void> {
    const response = await devLogin()
    setSessionToken(response.token)
    const configRes = await getConfig()
    setUser(response.user)
    setConfig(configRes)
    setNeedsLogin(false)
  }

  return (
    <AppContext.Provider value={{ user, config, loading, error, needsLogin, setBalance, loginWithWidgetData, loginAsDev }}>
      {children}
    </AppContext.Provider>
  )
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
