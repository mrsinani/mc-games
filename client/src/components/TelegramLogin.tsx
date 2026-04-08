import { useEffect, useRef, useState } from 'react'
import type { TelegramWidgetData } from '../lib/api'

declare global {
  interface Window {
    onTelegramAuth?: (user: TelegramWidgetData) => void
  }
}

interface TelegramLoginProps {
  onLogin: (data: TelegramWidgetData) => Promise<void>
}

export function TelegramLogin({ onLogin }: TelegramLoginProps) {
  const widgetRef = useRef<HTMLDivElement>(null)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    window.onTelegramAuth = async (user: TelegramWidgetData) => {
      setIsLoading(true)
      try {
        await onLogin(user)
      } finally {
        setIsLoading(false)
      }
    }

    const script = document.createElement('script')
    script.src = 'https://telegram.org/js/telegram-widget.js?22'
    script.setAttribute('data-telegram-login', import.meta.env.VITE_BOT_USERNAME as string)
    script.setAttribute('data-size', 'large')
    script.setAttribute('data-radius', '8')
    script.setAttribute('data-onauth', 'onTelegramAuth(user)')
    script.setAttribute('data-request-access', 'write')
    script.async = true

    if (widgetRef.current) {
      widgetRef.current.appendChild(script)
    }

    return () => {
      delete window.onTelegramAuth
    }
  }, [onLogin])

  return (
    <div className="min-h-dvh bg-black flex flex-col items-center justify-center px-6">
      <h1 className="text-white text-3xl font-bold mb-2">Casino</h1>
      <p className="text-neutral-400 text-sm mb-8">Sign in with your Telegram account to play</p>
      {isLoading ? (
        <p className="text-neutral-400 text-sm">Signing in...</p>
      ) : (
        <div ref={widgetRef} />
      )}
    </div>
  )
}
