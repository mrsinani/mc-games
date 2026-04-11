import { createHmac, createHash, randomBytes, randomUUID } from 'crypto'
import type { Server, Socket } from 'socket.io'
import type { SupabaseClient } from '@supabase/supabase-js'

function generateCrashPoint(serverSeed: string, nonce: number, rtp: number): number {
  const clientSeed = 'mvp1'
  const hash = createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`).digest('hex')
  const n = parseInt(hash.slice(0, 13), 16)
  const MAX = Math.pow(2, 52)
  const raw = ((100 * MAX) - n) / (MAX - n)
  const crashPoint = Math.max(1.00, Math.floor(raw * rtp) / 100)
  return crashPoint
}

export type RocketPhase = 'betting' | 'flight' | 'crash' | 'cooldown'

interface ActiveBet {
  entryId: string
  bet: number
  cashedOut: boolean
  cashoutPending: boolean
  cashoutAt: number | null
  payout: number | null
  username: string
  photoUrl: string | null
  autoCashoutAt: number | null
}

export interface RoundState {
  phase: RocketPhase
  roundId: string
  multiplier: number
  serverSeedHash: string
  elapsedMs: number
  /** When current betting or cooldown window ends (server clock); null in flight. */
  phaseEndsAt: number | null
}

// In-memory state
const activeBets = new Map<number, ActiveBet>()
const userSockets = new Map<number, string>() // telegram_id -> socket.id

let currentPhase: RocketPhase = 'cooldown'
let currentRoundId = ''
let currentMultiplier = 1.00
let currentServerSeed = ''
let currentServerSeedHash = ''
let previousServerSeed: string | null = null
let nonce = 0
let rtp = 0.93
let roundCount = 0
let tickInterval: ReturnType<typeof setInterval> | null = null
let roundStartTime = 0
let didRotateThisRound = false
/** Epoch ms when betting or cooldown phase ends; null during flight / idle. */
let currentPhaseEndsAt: number | null = null

let ioRef: Server | null = null
let supabaseRef: SupabaseClient | null = null

export function getRoundState(): RoundState {
  return {
    phase: currentPhase,
    roundId: currentRoundId,
    multiplier: currentMultiplier,
    serverSeedHash: currentServerSeedHash,
    elapsedMs: currentPhase === 'flight' ? Date.now() - roundStartTime : 0,
    phaseEndsAt: currentPhaseEndsAt,
  }
}

export function placeBet(
  telegramId: number,
  entryId: string,
  bet: number,
  username: string,
  photoUrl: string | null,
  autoCashoutAt: number | null
): { ok: boolean; reason?: 'phase' | 'duplicate' } {
  if (currentPhase !== 'betting') return { ok: false, reason: 'phase' }
  if (activeBets.has(telegramId)) return { ok: false, reason: 'duplicate' }
  activeBets.set(telegramId, {
    entryId, bet, cashedOut: false, cashoutPending: false, cashoutAt: null,
    payout: null, username, photoUrl, autoCashoutAt,
  })
  broadcastBets()
  return { ok: true }
}

export function prepareCashout(
  telegramId: number
): { multiplier: number; payout: number; entryId: string } | null {
  if (currentPhase !== 'flight') return null
  const betData = activeBets.get(telegramId)
  if (!betData || betData.cashedOut || betData.cashoutPending) return null

  const mult = currentMultiplier
  const payout = Math.floor(betData.bet * mult)

  // Mark pending to prevent concurrent cashouts before DB confirms
  betData.cashoutPending = true
  activeBets.set(telegramId, betData)

  return { multiplier: mult, payout, entryId: betData.entryId }
}

export function confirmCashout(telegramId: number, mult: number, payout: number): void {
  const betData = activeBets.get(telegramId)
  if (betData) {
    betData.cashedOut = true
    betData.cashoutPending = false
    betData.cashoutAt = mult
    betData.payout = payout
    activeBets.set(telegramId, betData)
    broadcastBets()
  }
}

export function rollbackCashout(telegramId: number): void {
  const betData = activeBets.get(telegramId)
  if (betData && betData.cashoutPending && !betData.cashedOut) {
    betData.cashoutPending = false
    activeBets.set(telegramId, betData)
  }
}

export function getCurrentRoundId(): string {
  return currentRoundId
}

export function emitToUser(telegramId: number, event: string, data: unknown): void {
  if (!ioRef) return
  const socketId = userSockets.get(telegramId)
  if (socketId) {
    ioRef.to(socketId).emit(event, data)
  }
}

export interface LiveBetEntry {
  username: string
  photoUrl: string | null
  bet: number
  cashedOut: boolean
  cashoutAt: number | null
  payout: number | null
}

function getActiveBetsList(): LiveBetEntry[] {
  const list: LiveBetEntry[] = []
  for (const b of activeBets.values()) {
    list.push({
      username: b.username,
      photoUrl: b.photoUrl,
      bet: b.bet,
      cashedOut: b.cashedOut,
      cashoutAt: b.cashoutAt,
      payout: b.payout,
    })
  }
  return list
}

function broadcastBets(): void {
  if (!ioRef) return
  ioRef.emit('bets:update', getActiveBetsList())
}

async function processAutoCashout(telegramId: number, betData: ActiveBet): Promise<void> {
  if (!supabaseRef) return

  const mult = currentMultiplier
  const payout = Math.floor(betData.bet * mult)

  betData.cashoutPending = true
  activeBets.set(telegramId, betData)

  try {
    const { creditBalance } = await import('../lib/balance')
    const balanceResult = await creditBalance(telegramId, payout, 'win', 'rocket')

    await supabaseRef
      .from('rocket_entries')
      .update({ cashout_at: mult, payout })
      .eq('id', betData.entryId)

    confirmCashout(telegramId, mult, payout)
    emitToUser(telegramId, 'cashout:confirmed', {
      cashoutAt: mult, payout, newBalance: balanceResult.newBalance,
    })
  } catch (err) {
    console.error('Auto-cashout failed for', telegramId, err)
    betData.cashoutPending = false
    activeBets.set(telegramId, betData)
  }
}

function checkAutoCashouts(): void {
  for (const [telegramId, betData] of activeBets.entries()) {
    if (
      betData.autoCashoutAt !== null &&
      !betData.cashedOut &&
      !betData.cashoutPending &&
      currentMultiplier >= betData.autoCashoutAt
    ) {
      void processAutoCashout(telegramId, betData)
    }
  }
}

function rotateSeed(): void {
  previousServerSeed = currentServerSeed
  currentServerSeed = randomBytes(32).toString('hex')
  currentServerSeedHash = createHash('sha256').update(currentServerSeed).digest('hex')
  didRotateThisRound = true
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runRound(): Promise<void> {
  if (!ioRef || !supabaseRef) return

  // Setup round
  currentPhase = 'betting'
  currentPhaseEndsAt = null
  activeBets.clear()
  currentRoundId = randomUUID()
  currentMultiplier = 1.00
  nonce++
  didRotateThisRound = false
  roundCount++

  // Rotate seed every 100 rounds
  if (roundCount % 100 === 1 && roundCount > 1) {
    rotateSeed()
  }

  const crashPoint = generateCrashPoint(currentServerSeed, nonce, rtp)

  // Persist round row at betting open so entries can reference it via FK
  try {
    await supabaseRef.from('rocket_rounds').insert({
      id: currentRoundId,
      seed: currentServerSeedHash,
      started_at: new Date().toISOString(),
    })
  } catch (err) {
    console.error('Failed to persist rocket round start:', err)
  }

  broadcastBets()

  const BETTING_DURATION_MS = 10_000
  /** Extra time after the UI countdown hits 0: still accept bets while requests sync in. */
  const BETTING_GRACE_MS = 1_000
  const bettingEndsAt = Date.now() + BETTING_DURATION_MS
  currentPhaseEndsAt = bettingEndsAt
  ioRef.emit('round:open', {
    roundId: currentRoundId,
    serverSeedHash: currentServerSeedHash,
    previousServerSeed: didRotateThisRound ? previousServerSeed : null,
    bettingDurationMs: BETTING_DURATION_MS,
    bettingEndsAt,
    bettingGraceMs: BETTING_GRACE_MS,
  })

  await sleep(BETTING_DURATION_MS + BETTING_GRACE_MS)

  // Launch phase
  currentPhase = 'flight'
  currentPhaseEndsAt = null
  roundStartTime = Date.now()
  ioRef.emit('round:launch', { roundId: currentRoundId })

  // Flight phase with 100ms ticks
  await new Promise<void>((resolve) => {
    tickInterval = setInterval(() => {
      if (!ioRef) return
      const elapsed = Date.now() - roundStartTime
      currentMultiplier = Math.floor(Math.pow(Math.E, 0.00006 * elapsed) * 100) / 100

      ioRef.emit('multiplier:tick', { multiplier: currentMultiplier, roundId: currentRoundId, elapsedMs: elapsed })

      checkAutoCashouts()

      if (currentMultiplier >= crashPoint) {
        if (tickInterval) {
          clearInterval(tickInterval)
          tickInterval = null
        }
        resolve()
      }
    }, 100)
  })

  // Crash phase
  currentPhase = 'crash'
  currentMultiplier = crashPoint

  const COOLDOWN_DURATION_MS = 10_000
  const cooldownEndsAt = Date.now() + COOLDOWN_DURATION_MS
  currentPhaseEndsAt = cooldownEndsAt
  ioRef.emit('round:crash', {
    crashPoint,
    roundId: currentRoundId,
    revealedSeed: didRotateThisRound ? previousServerSeed : null,
    cooldownDurationMs: COOLDOWN_DURATION_MS,
    cooldownEndsAt,
  })

  // Cooldown: update round row and settle losing entries
  currentPhase = 'cooldown'

  try {
    await supabaseRef
      .from('rocket_rounds')
      .update({
        crash_at: crashPoint,
        crashed_at: new Date().toISOString(),
      })
      .eq('id', currentRoundId)

    // Single update to settle all losing entries for this round
    await supabaseRef
      .from('rocket_entries')
      .update({ payout: 0 })
      .eq('round_id', currentRoundId)
      .is('cashout_at', null)
  } catch (err) {
    console.error('Failed to persist rocket round crash:', err)
  }

  await sleep(COOLDOWN_DURATION_MS)
}

function registerSocketHandlers(socket: Socket): void {
  socket.on('register', (data: { telegramId: number }) => {
    if (typeof data?.telegramId === 'number') {
      userSockets.set(data.telegramId, socket.id)

      const betData = activeBets.get(data.telegramId)
      if (betData) {
        socket.emit('bet:restored', {
          bet: betData.bet,
          cashedOut: betData.cashedOut,
          cashoutAt: betData.cashoutAt,
        })
      }
    }
  })

  socket.on('disconnect', () => {
    for (const [telegramId, socketId] of userSockets.entries()) {
      if (socketId === socket.id) {
        userSockets.delete(telegramId)
        break
      }
    }
  })

  // Send current state to newly connected client
  socket.emit('round:state', getRoundState())
  socket.emit('bets:update', getActiveBetsList())
}

export async function startRocketEngine(io: Server, supabase: SupabaseClient): Promise<void> {
  ioRef = io
  supabaseRef = supabase

  // Initialize first seed
  currentServerSeed = randomBytes(32).toString('hex')
  currentServerSeedHash = createHash('sha256').update(currentServerSeed).digest('hex')

  // Register socket connection handlers
  io.on('connection', registerSocketHandlers)

  // Fetch RTP from DB
  try {
    const { data } = await supabase
      .from('game_config')
      .select('value')
      .eq('key', 'rocket_rtp')
      .single()
    if (data?.value) {
      rtp = parseFloat(data.value as string)
    }
  } catch {
    console.log('Using default rocket RTP:', rtp)
  }

  // Continuous round loop
  void runLoop()
}

async function runLoop(): Promise<void> {
  while (true) {
    try {
      await runRound()
    } catch (err) {
      console.error('Rocket engine error:', err)
      if (tickInterval) {
        clearInterval(tickInterval)
        tickInterval = null
      }
      await sleep(3000)
    }
  }
}
