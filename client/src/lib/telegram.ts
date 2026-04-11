import { init, retrieveRawInitData } from '@telegram-apps/sdk-react'

let _initDataRaw: string | undefined
let _isTelegram = false

type TelegramWebApp = {
  ready: () => void
  expand: () => void
  onEvent?: (event: string, fn: (payload?: { isStateStable?: boolean }) => void) => void
}

function getLegacyWebApp(): TelegramWebApp | undefined {
  if (typeof window === 'undefined') return undefined
  const w = window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }
  return w.Telegram?.WebApp
}

/**
 * Align with Telegram’s WebApp lifecycle: expand the bottom sheet, subscribe to viewport /
 * safe-area updates (client updates --tg-* CSS vars; see core.telegram.org/bots/webapps).
 */
function bindTelegramViewportChrome(): void {
  const webApp = getLegacyWebApp()
  if (!webApp) return

  try {
    webApp.ready()
    webApp.expand()
  } catch {
    /* non-Telegram or older client */
  }

  /* Host updates --tg-* CSS vars; nudge layout so WebKit reapplies padding/height after sheet motion. */
  const nudgeLayout = () => {
    requestAnimationFrame(() => {
      void document.documentElement.getBoundingClientRect()
    })
  }

  webApp.onEvent?.('viewportChanged', nudgeLayout)
  webApp.onEvent?.('safeAreaChanged', nudgeLayout)
  webApp.onEvent?.('contentSafeAreaChanged', nudgeLayout)
  nudgeLayout()
}

export function initTelegram(): void {
  try {
    init()
    _initDataRaw = retrieveRawInitData()
    _isTelegram = true
    bindTelegramViewportChrome()
  } catch {
    _initDataRaw = undefined
    _isTelegram = false
  }
}

export function getInitDataRaw(): string | undefined {
  return _initDataRaw
}

export function isTelegram(): boolean {
  return _isTelegram
}
