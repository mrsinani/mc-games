import { getInitDataRaw } from './telegram'

const API_URL = import.meta.env.VITE_API_URL as string

const SESSION_TOKEN_KEY = 'session_token'

export function getSessionToken(): string | null {
  return localStorage.getItem(SESSION_TOKEN_KEY)
}

export function setSessionToken(token: string): void {
  localStorage.setItem(SESSION_TOKEN_KEY, token)
}

export function clearSessionToken(): void {
  localStorage.removeItem(SESSION_TOKEN_KEY)
}

async function parseErrorResponse(res: Response): Promise<string> {
  try {
    const body = await res.json()
    if (typeof body.error === 'string' && body.error) return body.error
    if (typeof body.message === 'string' && body.message) return body.message
  } catch {
    // response body is not JSON
  }
  return res.statusText || `HTTP ${res.status}`
}

export async function apiRequest<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const initDataRaw = getInitDataRaw()
  const sessionToken = getSessionToken()

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (initDataRaw) {
    headers['Authorization'] = `tma ${initDataRaw}`
  } else if (sessionToken) {
    headers['Authorization'] = `Bearer ${sessionToken}`
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { ...headers, ...options.headers },
  })
  if (!res.ok) {
    const message = await parseErrorResponse(res)
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

export interface UserResponse {
  telegram_id: number
  username: string
  first_name: string
  photo_url?: string
  balance: number
}

export interface LoginResponse {
  user: UserResponse
}

export interface MeResponse {
  user: UserResponse
}

export interface MeStatsResponse {
  totalWagered: number
  totalWon: number
}

export interface AddCoinsResponse {
  newBalance: number
}

export interface TelegramWidgetData {
  id: number
  first_name: string
  username?: string
  photo_url?: string
  auth_date: number
  hash: string
}

export interface WidgetLoginResponse {
  user: UserResponse
  balance: number
  token: string
}

export function login(): Promise<LoginResponse> {
  return apiRequest<LoginResponse>('/auth/login', { method: 'POST' })
}

export function getMe(): Promise<MeResponse> {
  return apiRequest<MeResponse>('/me')
}

export function getMeStats(): Promise<MeStatsResponse> {
  return apiRequest<MeStatsResponse>('/me/stats')
}

export function getConfig(): Promise<Record<string, unknown>> {
  return apiRequest<Record<string, unknown>>('/config')
}

export function addCoins(): Promise<AddCoinsResponse> {
  return apiRequest<AddCoinsResponse>('/dev/add-coins', { method: 'POST' })
}

export interface PlinkoStartResponse {
  ticketId: string
  newBalance: number
  path: number[]
}

export interface PlinkoSettleResponse {
  binIndex: number
  multiplier: number
  payout: number
  newBalance: number
}

export function startPlinko(
  bet: number,
  rowCount: number,
  riskLevel: string,
): Promise<PlinkoStartResponse> {
  return apiRequest<PlinkoStartResponse>('/plinko/start', {
    method: 'POST',
    body: JSON.stringify({ bet, rowCount, riskLevel }),
  })
}

export function settlePlinko(
  ticketId: string,
  binIndex: number,
): Promise<PlinkoSettleResponse> {
  return apiRequest<PlinkoSettleResponse>('/plinko/settle', {
    method: 'POST',
    body: JSON.stringify({ ticketId, binIndex }),
  })
}

export interface RocketBetResponse {
  success: boolean
  balance: number
}

export interface RocketCashoutResponse {
  success: boolean
  cashoutAt: number
  payout: number
  newBalance: number
}

export function rocketPlaceBet(bet: number, autoCashoutAt?: number | null): Promise<RocketBetResponse> {
  return apiRequest<RocketBetResponse>('/rocket/bet', {
    method: 'POST',
    body: JSON.stringify({ bet, autoCashoutAt: autoCashoutAt ?? undefined }),
  })
}

export function rocketCashout(): Promise<RocketCashoutResponse> {
  return apiRequest<RocketCashoutResponse>('/rocket/cashout', { method: 'POST' })
}

// ── PVP ──────────────────────────────────────────────────────────────────────

export interface PvpPlayer {
  username: string | null
  first_name: string | null
  photo_url: string | null
}

export interface PvpEntry {
  id: string
  user_id: number
  bet: number
  ticket_start: number
  ticket_end: number
  player: PvpPlayer | null
}

export interface PvpRoom {
  id: string
  title: string
  creator_id: number
  creator: PvpPlayer | null
  status: 'open' | 'spinning' | 'finished' | 'cancelled'
  min_bet: number
  max_bet: number
  house_cut_pct: number
  total_pot: number
  pvp_entries: PvpEntry[]
  winner_id: number | null
  winner_name: string | null
  winner_photo_url: string | null
  payout: number | null
  created_at: string
  finished_at: string | null
  // list view extras
  player_count?: number
}

export interface PvpRoomsResponse { rooms: PvpRoom[] }
export interface PvpRoomResponse { room: PvpRoom }
export interface PvpCreateRoomResponse { room: PvpRoom }
export interface PvpBetResponse { success: boolean; entry_id: string; ticket_start: number; ticket_end: number; new_balance: number }

export function pvpGetRooms(): Promise<PvpRoomsResponse> {
  return apiRequest<PvpRoomsResponse>('/pvp/rooms')
}

export function pvpGetRoom(id: string): Promise<PvpRoomResponse> {
  return apiRequest<PvpRoomResponse>(`/pvp/rooms/${id}`)
}

export function pvpCreateRoom(title: string, minBet: number, maxBet: number): Promise<PvpCreateRoomResponse> {
  return apiRequest<PvpCreateRoomResponse>('/pvp/rooms', {
    method: 'POST',
    body: JSON.stringify({ title, minBet, maxBet }),
  })
}

export function pvpPlaceBet(roomId: string, bet: number): Promise<PvpBetResponse> {
  return apiRequest<PvpBetResponse>(`/pvp/rooms/${roomId}/bet`, {
    method: 'POST',
    body: JSON.stringify({ bet }),
  })
}

export function pvpStartSpin(roomId: string): Promise<{ success: boolean }> {
  return apiRequest<{ success: boolean }>(`/pvp/rooms/${roomId}/start`, { method: 'POST' })
}

export function pvpCancelRoom(roomId: string): Promise<{ success: boolean }> {
  return apiRequest<{ success: boolean }>(`/pvp/rooms/${roomId}/cancel`, { method: 'POST' })
}

export async function devLogin(): Promise<WidgetLoginResponse> {
  const res = await fetch(`${API_URL}/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) {
    const message = await parseErrorResponse(res)
    throw new Error(message)
  }
  return res.json() as Promise<WidgetLoginResponse>
}

export async function loginWithWidget(data: TelegramWidgetData): Promise<WidgetLoginResponse> {
  const res = await fetch(`${API_URL}/auth/telegram-widget`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const message = await parseErrorResponse(res)
    throw new Error(message)
  }
  return res.json() as Promise<WidgetLoginResponse>
}
