import { init, retrieveRawInitData } from '@telegram-apps/sdk-react'

let _initDataRaw: string | undefined
let _isTelegram = false

export function initTelegram(): void {
  try {
    init()
    _initDataRaw = retrieveRawInitData()
    _isTelegram = true
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
