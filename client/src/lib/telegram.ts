import { init, retrieveRawInitData } from '@telegram-apps/sdk-react'

let _initDataRaw: string | undefined
let _isTelegram = false

function getLegacyWebApp(): { expand?: () => void } | undefined {
  if (typeof window === 'undefined') return undefined
  const w = window as unknown as { Telegram?: { WebApp?: { expand?: () => void } } }
  return w.Telegram?.WebApp
}

export function initTelegram(): void {
  try {
    init()
    _initDataRaw = retrieveRawInitData()
    _isTelegram = true
    /* One extra call: expand the mobile bottom sheet. SDK init() already wires WebApp — avoid a second ready()/event layer. */
    try {
      getLegacyWebApp()?.expand?.()
    } catch {
      /* desktop / unsupported */
    }
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
