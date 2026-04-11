import { useEffect, useRef, useState, useCallback } from 'react'
import { io as socketIo, Socket } from 'socket.io-client'
import { rocketPlaceBet, rocketCashout } from '../lib/api'
import { useApp } from '../context/AppContext'

/** Fallback if server omits absolute end times (must match server defaults). */
const ROCKET_FALLBACK_BETTING_MS = 10_000
const ROCKET_FALLBACK_COOLDOWN_MS = 10_000

/* ─── Rising-curve chart component ───────────────────────────────── */

interface CurveChartProps {
  multiplier: number
  phase: GamePhase
  crashedAt: number | null
  cashedOutAt: number | null
  elapsedMs: number
}

function CurveChart({ multiplier, phase, crashedAt, cashedOutAt, elapsedMs }: CurveChartProps) {
  const historyRef = useRef<number[]>([1])
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef<number>(0)

  const propsRef = useRef({ multiplier, phase, crashedAt, cashedOutAt, elapsedMs })
  propsRef.current = { multiplier, phase, crashedAt, cashedOutAt, elapsedMs }

  // Accumulate multiplier ticks during flight
  useEffect(() => {
    if (phase === 'betting' || phase === 'cooldown') {
      historyRef.current = [1]
    } else if (phase === 'flight') {
      if (historyRef.current.length <= 1 && multiplier > 1.01 && elapsedMs > 200) {
        const steps = Math.min(Math.round(elapsedMs / 100), 300)
        const history: number[] = []
        for (let i = 0; i <= steps; i++) {
          const t = (elapsedMs / steps) * i
          history.push(Math.floor(Math.pow(Math.E, 0.00006 * t) * 100) / 100)
        }
        historyRef.current = history
      } else {
        historyRef.current.push(multiplier)
      }
    } else if (phase === 'crash' && crashedAt !== null) {
      const last = historyRef.current[historyRef.current.length - 1]
      if (last !== crashedAt) historyRef.current.push(crashedAt)
    }
  }, [multiplier, phase, crashedAt, elapsedMs])

  // Canvas draw loop — runs once, reads latest values from refs
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    function draw() {
      const p = propsRef.current
      const rect = container!.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const w = rect.width
      const h = rect.height
      canvas!.width = w * dpr
      canvas!.height = h * dpr
      canvas!.style.width = `${w}px`
      canvas!.style.height = `${h}px`
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)

      const history = historyRef.current
      const pts = history.length
      const crashed = p.phase === 'crash'

      ctx!.clearRect(0, 0, w, h)

      const bgRadius = 16
      ctx!.beginPath()
      ctx!.roundRect(0, 0, w, h, bgRadius)
      ctx!.fillStyle = '#1a1d26'
      ctx!.fill()

      const pad = { l: 48, r: 16, t: 20, b: 36 }
      const chartW = w - pad.l - pad.r
      const chartH = h - pad.t - pad.b

      const maxMul = Math.max(2, ...history) * 1.15
      const toY = (v: number) => pad.t + chartH - ((v - 1) / (maxMul - 1)) * chartH
      const toX = (i: number) => pad.l + (pts > 1 ? (i / (pts - 1)) * chartW : chartW / 2)

      const gridSteps = getGridSteps(maxMul)
      for (const v of gridSteps) {
        const y = toY(v)
        if (y < pad.t || y > pad.t + chartH) continue
        ctx!.strokeStyle = 'rgba(255,255,255,0.07)'
        ctx!.lineWidth = 1
        ctx!.setLineDash([3, 3])
        ctx!.beginPath()
        ctx!.moveTo(pad.l, y)
        ctx!.lineTo(w - pad.r, y)
        ctx!.stroke()
        ctx!.setLineDash([])
        ctx!.font = '12px ui-monospace, monospace'
        ctx!.textAlign = 'right'
        ctx!.fillStyle = 'rgba(255,255,255,0.4)'
        ctx!.fillText(`${v.toFixed(1)}x`, pad.l - 8, y + 4)
      }
      const baseY = toY(1)
      ctx!.font = '12px ui-monospace, monospace'
      ctx!.textAlign = 'right'
      ctx!.fillStyle = 'rgba(255,255,255,0.4)'
      ctx!.fillText('1.0x', pad.l - 8, baseY + 4)

      const totalSec = p.elapsedMs / 1000
      const timeSteps = getTimeSteps(totalSec)
      ctx!.font = '11px ui-monospace, monospace'
      ctx!.textAlign = 'center'
      ctx!.fillStyle = 'rgba(255,255,255,0.35)'
      for (const t of timeSteps) {
        const frac = totalSec > 0 ? t / totalSec : 0
        const x = pad.l + frac * chartW
        if (x < pad.l + 20 || x > w - pad.r - 10) continue
        ctx!.fillText(`${Math.round(t)}s`, x, h - 8)
        ctx!.strokeStyle = 'rgba(255,255,255,0.1)'
        ctx!.lineWidth = 1
        ctx!.beginPath()
        ctx!.moveTo(x, pad.t + chartH)
        ctx!.lineTo(x, pad.t + chartH + 4)
        ctx!.stroke()
      }

      if (pts < 2) {
        rafRef.current = requestAnimationFrame(draw)
        return
      }

      const fillColor = crashed ? 'rgba(239,68,68,0.7)' : 'rgba(245,166,35,0.85)'
      const fillColorFade = crashed ? 'rgba(239,68,68,0.15)' : 'rgba(245,166,35,0.25)'
      const grad = ctx!.createLinearGradient(0, pad.t, 0, pad.t + chartH)
      grad.addColorStop(0, fillColor)
      grad.addColorStop(1, fillColorFade)

      ctx!.beginPath()
      ctx!.moveTo(toX(0), toY(history[0]))
      for (let i = 1; i < pts; i++) {
        ctx!.lineTo(toX(i), toY(history[i]))
      }
      ctx!.lineTo(toX(pts - 1), pad.t + chartH)
      ctx!.lineTo(toX(0), pad.t + chartH)
      ctx!.closePath()
      ctx!.fillStyle = grad
      ctx!.fill()

      const lineColor = crashed ? '#ef4444' : '#ffffff'
      ctx!.beginPath()
      ctx!.moveTo(toX(0), toY(history[0]))
      for (let i = 1; i < pts; i++) {
        ctx!.lineTo(toX(i), toY(history[i]))
      }
      ctx!.strokeStyle = lineColor
      ctx!.lineWidth = 3
      ctx!.lineJoin = 'round'
      ctx!.lineCap = 'round'
      ctx!.stroke()

      const lastX = toX(pts - 1)
      const lastY = toY(history[pts - 1])

      if (!crashed) {
        ctx!.beginPath()
        ctx!.arc(lastX, lastY, 12, 0, Math.PI * 2)
        ctx!.fillStyle = 'rgba(255,255,255,0.15)'
        ctx!.fill()
        ctx!.beginPath()
        ctx!.arc(lastX, lastY, 6, 0, Math.PI * 2)
        ctx!.fillStyle = '#ffffff'
        ctx!.fill()
      }

      if (p.cashedOutAt !== null && p.cashedOutAt > 1) {
        const cY = toY(p.cashedOutAt)
        let cIdx = history.findIndex((v) => v >= p.cashedOutAt!)
        if (cIdx === -1) cIdx = pts - 1
        const cX = toX(cIdx)
        ctx!.setLineDash([4, 4])
        ctx!.strokeStyle = 'rgba(255,255,255,0.3)'
        ctx!.lineWidth = 1
        ctx!.beginPath()
        ctx!.moveTo(pad.l, cY)
        ctx!.lineTo(w - pad.r, cY)
        ctx!.stroke()
        ctx!.setLineDash([])
        ctx!.beginPath()
        ctx!.arc(cX, cY, 7, 0, Math.PI * 2)
        ctx!.fillStyle = '#ffffff'
        ctx!.fill()
        ctx!.beginPath()
        ctx!.arc(cX, cY, 4, 0, Math.PI * 2)
        ctx!.fillStyle = '#22c55e'
        ctx!.fill()
      }

      if (crashed) {
        const size = 12
        ctx!.strokeStyle = '#ef4444'
        ctx!.lineWidth = 3.5
        ctx!.lineCap = 'round'
        ctx!.beginPath()
        ctx!.moveTo(lastX - size, lastY - size)
        ctx!.lineTo(lastX + size, lastY + size)
        ctx!.moveTo(lastX + size, lastY - size)
        ctx!.lineTo(lastX - size, lastY + size)
        ctx!.stroke()
      }

      const mulText = `${(crashed ? p.crashedAt! : p.multiplier).toFixed(2)}x`
      const fontSize = Math.min(w * 0.18, 72)
      ctx!.font = `900 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
      ctx!.textAlign = 'center'
      ctx!.textBaseline = 'middle'
      const textX = pad.l + chartW * 0.45
      const textY = pad.t + chartH * 0.55
      ctx!.fillStyle = 'rgba(0,0,0,0.4)'
      ctx!.fillText(mulText, textX + 2, textY + 2)
      ctx!.fillStyle = crashed ? '#ef4444' : '#ffffff'
      ctx!.fillText(mulText, textX, textY)

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={containerRef} className="w-full h-full relative rounded-2xl overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
    </div>
  )
}

/** Pick nice grid step values for the y-axis */
function getGridSteps(maxMul: number): number[] {
  const steps: number[] = []
  let step = 0.5
  if (maxMul > 5) step = 1
  if (maxMul > 15) step = 2
  if (maxMul > 30) step = 5
  if (maxMul > 80) step = 10
  for (let v = 1 + step; v < maxMul; v += step) {
    steps.push(v)
  }
  return steps
}

/** Pick time labels for x-axis */
function getTimeSteps(totalSec: number): number[] {
  if (totalSec <= 0) return []
  const steps: number[] = []
  let step = 2
  if (totalSec > 15) step = 5
  if (totalSec > 40) step = 10
  if (totalSec > 100) step = 20
  for (let t = step; t < totalSec; t += step) {
    steps.push(t)
  }
  return steps
}

interface LiveBet {
  username: string
  photoUrl: string | null
  bet: number
  cashedOut: boolean
  cashoutAt: number | null
  payout: number | null
}

type GamePhase = 'betting' | 'flight' | 'crash' | 'cooldown'

interface RoundOpenPayload {
  roundId: string
  serverSeedHash: string
  previousServerSeed: string | null
  bettingDurationMs?: number
  /** Server epoch ms when betting closes (authoritative for countdown). */
  bettingEndsAt?: number
  /** ms after countdown hits 0 that the server still accepts bets (sync buffer). */
  bettingGraceMs?: number
}

interface MultiplierTickPayload {
  multiplier: number
  roundId?: string
  elapsedMs?: number
}

interface RoundCrashPayload {
  crashPoint: number
  roundId: string
  revealedSeed: string | null
  cooldownDurationMs?: number
  /** Server epoch ms when the next round opens (authoritative for countdown). */
  cooldownEndsAt?: number
}

interface CashoutConfirmedPayload {
  cashoutAt: number
  payout: number
  newBalance: number
}

interface RoundStatePayload {
  phase: GamePhase
  roundId: string
  multiplier: number
  serverSeedHash: string
  elapsedMs?: number
  phaseEndsAt?: number | null
}

export function RocketGame() {
  const { user, setBalance, config } = useApp()

  const minBet = Math.max(1, Number(config?.['min_bet']) || 10)
  const maxBet = Math.max(minBet, Number(config?.['max_bet']) || 10000)

  const [phase, setPhase] = useState<GamePhase>('cooldown')
  const [multiplier, setMultiplier] = useState(1.00)
  const [crashedAt, setCrashedAt] = useState<number | null>(null)
  const [bet, setBet] = useState(minBet)
  const [autoCashoutEnabled, setAutoCashoutEnabled] = useState(false)
  const [autoCashoutValue, setAutoCashoutValue] = useState('2.0')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [hasActiveBet, setHasActiveBet] = useState(false)
  const [cashedOut, setCashedOut] = useState(false)
  const [cashoutResult, setCashoutResult] = useState<{ cashoutAt: number; payout: number } | null>(null)
  const [lostRound, setLostRound] = useState(false)
  const [betError, setBetError] = useState<string | null>(null)
  const [apiError, setApiError] = useState<string | null>(null)
  const [isPlacingBet, setIsPlacingBet] = useState(false)
  const [isCashingOut, setIsCashingOut] = useState(false)
  const [flashRed, setFlashRed] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [liveBets, setLiveBets] = useState<LiveBet[]>([])

  const socketRef = useRef<Socket | null>(null)
  const hasActiveBetRef = useRef(false)
  const cashedOutRef = useRef(false)
  const currentRoundIdRef = useRef<string>('')
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Keep refs in sync
  hasActiveBetRef.current = hasActiveBet
  cashedOutRef.current = cashedOut

  const clearCountdown = useCallback(() => {
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current)
      countdownIntervalRef.current = null
    }
    setCountdown(null)
  }, [])

  /** Count down to a server-provided instant so reconnects stay in sync and intervals aren’t wiped by effect re-runs. */
  const syncCountdownToEnd = useCallback((endsAt: number) => {
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current)
      countdownIntervalRef.current = null
    }
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000))
      setCountdown(remaining)
      if (remaining <= 0 && countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current)
        countdownIntervalRef.current = null
      }
    }
    tick()
    countdownIntervalRef.current = setInterval(tick, 250)
  }, [])

  const handleRoundOpen = useCallback((payload: RoundOpenPayload) => {
    currentRoundIdRef.current = payload.roundId
    setPhase('betting')
    setMultiplier(1.00)
    setCrashedAt(null)
    setHasActiveBet(false)
    setCashedOut(false)
    setCashoutResult(null)
    setLostRound(false)
    setBetError(null)
    setApiError(null)
    setFlashRed(false)
    setElapsedMs(0)
    const endsAt =
      payload.bettingEndsAt ??
      Date.now() + (payload.bettingDurationMs ?? ROCKET_FALLBACK_BETTING_MS)
    syncCountdownToEnd(endsAt)
  }, [syncCountdownToEnd])

  const handleRoundLaunch = useCallback(() => {
    setPhase('flight')
    setElapsedMs(0)
    clearCountdown()
  }, [clearCountdown])

  const handleMultiplierTick = useCallback((payload: MultiplierTickPayload) => {
    if (payload.roundId !== undefined && payload.roundId !== currentRoundIdRef.current) return
    setMultiplier(payload.multiplier)
    if (payload.elapsedMs !== undefined) setElapsedMs(payload.elapsedMs)
  }, [])

  const handleRoundCrash = useCallback((payload: RoundCrashPayload) => {
    if (payload.roundId !== currentRoundIdRef.current) return
    setPhase('crash')
    setCrashedAt(payload.crashPoint)
    setMultiplier(payload.crashPoint)
    setFlashRed(true)
    setTimeout(() => setFlashRed(false), 600)
    const endsAt =
      payload.cooldownEndsAt ??
      Date.now() + (payload.cooldownDurationMs ?? ROCKET_FALLBACK_COOLDOWN_MS)
    syncCountdownToEnd(endsAt)

    // Determine if user lost
    if (hasActiveBetRef.current && !cashedOutRef.current) {
      setLostRound(true)
    }
  }, [syncCountdownToEnd])

  const handleCashoutConfirmed = useCallback((payload: CashoutConfirmedPayload) => {
    setCashedOut(true)
    setCashoutResult({ cashoutAt: payload.cashoutAt, payout: payload.payout })
    setBalance(payload.newBalance)
  }, [setBalance])

  const handleRoundState = useCallback(
    (payload: RoundStatePayload) => {
      currentRoundIdRef.current = payload.roundId
      setPhase(payload.phase)
      setMultiplier(payload.multiplier)
      setCrashedAt(null)
      setElapsedMs(payload.elapsedMs ?? 0)

      if (payload.phase === 'flight') {
        clearCountdown()
        return
      }
      const end = payload.phaseEndsAt
      if (payload.phase === 'betting') {
        if (typeof end === 'number') syncCountdownToEnd(end)
        else syncCountdownToEnd(Date.now() + ROCKET_FALLBACK_BETTING_MS)
        return
      }
      if (payload.phase === 'cooldown') {
        if (typeof end === 'number') syncCountdownToEnd(end)
        else syncCountdownToEnd(Date.now() + ROCKET_FALLBACK_COOLDOWN_MS)
        return
      }
      clearCountdown()
    },
    [clearCountdown, syncCountdownToEnd],
  )

  const handleBetRestored = useCallback((payload: { bet: number; cashedOut: boolean; cashoutAt: number | null }) => {
    setBet(payload.bet)
    setHasActiveBet(true)
    if (payload.cashedOut && payload.cashoutAt !== null) {
      setCashedOut(true)
      setCashoutResult({ cashoutAt: payload.cashoutAt, payout: Math.floor(payload.bet * payload.cashoutAt) })
    }
  }, [])

  const socketHandlersRef = useRef({
    handleRoundOpen,
    handleRoundLaunch,
    handleMultiplierTick,
    handleRoundCrash,
    handleCashoutConfirmed,
    handleRoundState,
    handleBetRestored,
  })
  socketHandlersRef.current = {
    handleRoundOpen,
    handleRoundLaunch,
    handleMultiplierTick,
    handleRoundCrash,
    handleCashoutConfirmed,
    handleRoundState,
    handleBetRestored,
  }

  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL as string
    const socket = socketIo(apiUrl, { transports: ['websocket', 'polling'] })
    socketRef.current = socket

    socket.on('connect', () => {
      const id = user?.telegram_id
      if (id) socket.emit('register', { telegramId: id })
    })

    socket.on('round:open', (p: RoundOpenPayload) => socketHandlersRef.current.handleRoundOpen(p))
    socket.on('round:launch', () => socketHandlersRef.current.handleRoundLaunch())
    socket.on('multiplier:tick', (p: MultiplierTickPayload) =>
      socketHandlersRef.current.handleMultiplierTick(p),
    )
    socket.on('round:crash', (p: RoundCrashPayload) => socketHandlersRef.current.handleRoundCrash(p))
    socket.on('cashout:confirmed', (p: CashoutConfirmedPayload) =>
      socketHandlersRef.current.handleCashoutConfirmed(p),
    )
    socket.on('round:state', (p: RoundStatePayload) => socketHandlersRef.current.handleRoundState(p))
    socket.on('bet:restored', (p: { bet: number; cashedOut: boolean; cashoutAt: number | null }) =>
      socketHandlersRef.current.handleBetRestored(p),
    )
    socket.on('bets:update', (bets: LiveBet[]) => setLiveBets(bets))

    return () => {
      socket.disconnect()
      socketRef.current = null
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current)
        countdownIntervalRef.current = null
      }
    }
  }, [user?.telegram_id])

  async function handlePlaceBet() {
    if (isPlacingBet || phase !== 'betting') return
    setBetError(null)
    setApiError(null)

    if (bet < minBet || bet > maxBet) {
      setBetError(`Bet must be between ${minBet} and ${maxBet}`)
      return
    }

    setIsPlacingBet(true)
    const parsed = parseFloat(autoCashoutValue)
    const autoCashoutAt = autoCashoutEnabled && isFinite(parsed) && parsed >= 1.01 ? parsed : null
    try {
      const result = await rocketPlaceBet(bet, autoCashoutAt)
      setHasActiveBet(true)
      setBalance(result.balance)
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Failed to place bet')
    } finally {
      setIsPlacingBet(false)
    }
  }

  async function handleCashout() {
    if (isCashingOut || phase !== 'flight' || !hasActiveBet || cashedOut) return
    setIsCashingOut(true)

    const snapMultiplier = multiplier
    const snapPayout = Math.floor(bet * snapMultiplier)
    setCashedOut(true)
    setCashoutResult({ cashoutAt: snapMultiplier, payout: snapPayout })

    try {
      const result = await rocketCashout()
      setCashoutResult({ cashoutAt: result.cashoutAt, payout: result.payout })
      setBalance(result.newBalance)
    } catch (err) {
      setCashedOut(false)
      setCashoutResult(null)
      setApiError(err instanceof Error ? err.message : 'Failed to cash out')
    } finally {
      setIsCashingOut(false)
    }
  }

  const displayMultiplier = multiplier.toFixed(2)
  const projectedCashoutPayout = Math.floor(bet * multiplier)

  function getStatusText(): string {
    const countdownStr = countdown !== null && countdown > 0 ? ` (${countdown}s)` : ''
    switch (phase) {
      case 'betting':
        return `Place your bets!${countdownStr}`
      case 'flight':
        return ''
      case 'crash':
        return `Crashed at ${crashedAt?.toFixed(2)}x`
      case 'cooldown':
        return `Next round starting...${countdownStr}`
    }
  }

  return (
    <div className="h-full bg-[#0e1117] flex flex-col overflow-hidden relative">
      {/* Chart area */}
      <div className="shrink-0 px-3 pt-3 pb-2" style={{ height: '55%' }}>
        <div className={`h-full transition-opacity duration-150 ${flashRed ? 'opacity-40' : 'opacity-100'}`}>
          {phase === 'flight' || phase === 'crash' ? (
            <CurveChart
              multiplier={multiplier}
              phase={phase}
              crashedAt={crashedAt}
              cashedOutAt={cashoutResult?.cashoutAt ?? null}
              elapsedMs={elapsedMs}
            />
          ) : (
            <div className="w-full h-full rounded-2xl bg-[#1a1d26] flex flex-col items-center justify-center gap-3">
              <p className="text-5xl font-black text-white tabular-nums">{displayMultiplier}x</p>
              <p className="text-neutral-400 text-sm">{getStatusText()}</p>
            </div>
          )}
        </div>
      </div>

      {/* Bottom section — scrollable: result feedback + live bets + controls */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
        {/* Round result feedback */}
        {hasActiveBet && (phase === 'crash' || (phase === 'flight' && cashedOut)) && cashoutResult && (
          <div className="mx-3 mb-2 bg-[#1a1d26] border border-green-800 rounded-xl px-4 py-3 text-center">
            <p className="text-green-400 font-bold text-lg">+{cashoutResult.payout} coins</p>
            <p className="text-neutral-400 text-xs mt-0.5">Cashed out at {cashoutResult.cashoutAt.toFixed(2)}x</p>
          </div>
        )}
        {phase === 'crash' && hasActiveBet && lostRound && !cashedOut && (
          <div className="mx-3 mb-2 bg-[#1a1d26] border border-red-900 rounded-xl px-4 py-3 text-center">
            <p className="text-red-400 font-semibold">Crashed — you lost {bet} coins</p>
          </div>
        )}

        {/* Controls */}
        <div className="shrink-0 flex flex-col gap-3 px-3 pb-3 pt-1">
        {/* Betting phase controls */}
        {phase === 'betting' && !hasActiveBet && (
          <>
            <div className="flex gap-3">
              <div className="flex-1 flex flex-col gap-1">
                <label className="text-neutral-400 text-xs font-medium uppercase tracking-wide">
                  Bet Amount
                </label>
                <input
                  type="number"
                  value={bet}
                  onChange={(e) => {
                    setBetError(null)
                    setBet(Math.max(1, parseInt(e.target.value) || 0))
                  }}
                  disabled={isPlacingBet}
                  className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-white text-base focus:outline-none focus:border-neutral-500 disabled:opacity-50"
                  min={minBet}
                  max={maxBet}
                />
              </div>
              <div className="flex-1 flex flex-col gap-1">
                <label className="text-neutral-400 text-xs font-medium uppercase tracking-wide">
                  Auto Cashout
                </label>
                <div className="flex gap-1.5">
                  <input
                    type="number"
                    value={autoCashoutEnabled ? autoCashoutValue : ''}
                    onChange={(e) => {
                      const val = e.target.value
                      if (val === '') {
                        setAutoCashoutEnabled(false)
                      } else {
                        setAutoCashoutEnabled(true)
                        setAutoCashoutValue(val)
                      }
                    }}
                    placeholder="Off"
                    disabled={isPlacingBet}
                    step="0.1"
                    min="1.01"
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-white text-base focus:outline-none focus:border-neutral-500 disabled:opacity-50 placeholder:text-neutral-600"
                  />
                  <button
                    onClick={() => setSettingsOpen(true)}
                    className="shrink-0 w-10 h-10 flex items-center justify-center rounded-lg border border-neutral-700 bg-neutral-900 text-white hover:bg-neutral-800 transition-colors"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
                      <circle cx="12" cy="12" r="3"/>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
            {betError && <p className="text-red-400 text-xs">{betError}</p>}

            <div className="flex gap-2">
              {[10, 50, 100, 500].map((amount) => (
                <button
                  key={amount}
                  onClick={() => setBet(amount)}
                  disabled={isPlacingBet}
                  className="flex-1 bg-neutral-900 border border-neutral-700 text-white text-sm font-medium rounded-lg py-2 hover:border-neutral-600 disabled:opacity-50"
                >
                  {amount}
                </button>
              ))}
            </div>

            <button
              onClick={handlePlaceBet}
              disabled={isPlacingBet}
              className="w-full bg-white text-black font-bold rounded-lg py-3 text-base hover:bg-neutral-100 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isPlacingBet ? 'Placing Bet...' : 'Place Bet'}
            </button>
          </>
        )}

        {/* Betting phase — bet placed, waiting for launch */}
        {phase === 'betting' && hasActiveBet && (
          <div className="flex gap-2 items-center">
            <div className="flex-1 bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-3 text-center">
              <p className="text-white font-semibold">Bet placed: {bet} coins</p>
              <p className="text-neutral-400 text-sm mt-1">
                Launching in {countdown !== null && countdown > 0 ? `${countdown}s` : '...'}
              </p>
            </div>
            <button
              onClick={() => setSettingsOpen(true)}
              className="shrink-0 w-10 h-10 flex items-center justify-center rounded-lg border border-neutral-700 bg-neutral-900 text-white hover:bg-neutral-800 transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
        )}

        {/* Flight phase — cash out button */}
        {phase === 'flight' && hasActiveBet && !cashedOut && (
          <div className="flex gap-2 items-center">
            <button
              onClick={handleCashout}
              disabled={isCashingOut}
              className="flex-1 flex flex-col items-center justify-center gap-1 rounded-xl py-4 bg-gradient-to-b from-green-500 to-green-600 text-white font-black shadow-lg shadow-black/25 border border-green-400/40 hover:from-green-400 hover:to-green-500 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] transition-transform"
            >
              {isCashingOut ? (
                <span className="text-xl">Cashing Out...</span>
              ) : (
                <>
                  <span className="text-xl sm:text-2xl tabular-nums">Cash Out {displayMultiplier}x</span>
                  <span className="text-green-400 text-lg sm:text-xl font-bold tabular-nums drop-shadow-sm">
                    +{projectedCashoutPayout.toLocaleString()} coins
                  </span>
                </>
              )}
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              className="shrink-0 w-10 h-10 flex items-center justify-center rounded-lg border border-neutral-700 bg-neutral-900 text-white hover:bg-neutral-800 transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
        )}

        {/* Flight phase — watching (no active bet) */}
        {phase === 'flight' && !hasActiveBet && (
          <div className="flex gap-2 items-center">
            <div className="flex-1 bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-3 text-center">
              <p className="text-neutral-400 text-sm">Watching — place a bet next round</p>
            </div>
            <button
              onClick={() => setSettingsOpen(true)}
              className="shrink-0 w-10 h-10 flex items-center justify-center rounded-lg border border-neutral-700 bg-neutral-900 text-white hover:bg-neutral-800 transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
        )}

        {/* Crash/cooldown phase */}
        {(phase === 'crash' || phase === 'cooldown') && !hasActiveBet && (
          <div className="flex gap-2 items-center">
            <div className="flex-1 bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-3 text-center">
              <p className="text-neutral-400 text-sm">
                {countdown !== null && countdown > 0
                  ? `Next round in ${countdown}s`
                  : 'Next round starting...'}
              </p>
            </div>
            <button
              onClick={() => setSettingsOpen(true)}
              className="shrink-0 w-10 h-10 flex items-center justify-center rounded-lg border border-neutral-700 bg-neutral-900 text-white hover:bg-neutral-800 transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
        )}

        {/* API error */}
        {apiError && (
          <p className="text-red-400 text-sm text-center">{apiError}</p>
        )}
      </div>

        {/* Live Bets */}
        {liveBets.length > 0 && (
          <div className="px-3 pb-3 mt-1">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-neutral-400 text-xs font-semibold uppercase tracking-wide">
                Live Bets
              </span>
              <span className="text-neutral-500 text-xs">({liveBets.length})</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {liveBets.map((lb, i) => (
                <div
                  key={i}
                  className={`flex items-center justify-between px-3 py-2 rounded-lg ${
                    lb.cashedOut
                      ? 'bg-emerald-950/40 border border-emerald-800/40'
                      : 'bg-[#1a1d26]'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    {lb.photoUrl ? (
                      <img
                        src={lb.photoUrl}
                        className="w-7 h-7 rounded-full shrink-0 object-cover"
                        alt=""
                      />
                    ) : (
                      <div className="w-7 h-7 rounded-full shrink-0 bg-neutral-700 flex items-center justify-center text-neutral-300 text-xs font-bold">
                        {lb.username.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="text-white text-sm font-medium truncate">{lb.username}</p>
                      <p className="text-neutral-400 text-xs">{lb.bet} coins</p>
                    </div>
                  </div>
                  {lb.cashedOut && lb.cashoutAt !== null && lb.payout !== null && (
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-white text-sm font-semibold">+{lb.payout}</span>
                      <span className="bg-green-600/60 text-green-300 text-xs font-bold px-2 py-0.5 rounded">
                        {lb.cashoutAt.toFixed(2)}x
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Settings panel */}
      {settingsOpen && (
        <div className="absolute inset-0 z-50 flex flex-col justify-end">
          <div className="absolute inset-0 bg-black/60" onClick={() => setSettingsOpen(false)} />
          <div className="relative bg-[#1a1d26] rounded-t-2xl px-5 pt-5 pb-6 flex flex-col gap-5">
            <div className="flex items-center justify-between">
              <h2 className="text-white font-bold text-lg">Rocket Settings</h2>
              <button
                onClick={() => setSettingsOpen(false)}
                className="text-neutral-400 hover:text-white w-8 h-8 flex items-center justify-center rounded-lg"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* Auto Cashout */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white font-medium text-sm">Auto Cashout</p>
                <p className="text-neutral-500 text-xs mt-0.5">Auto cashout when the multiplier is reached</p>
              </div>
              <button
                onClick={() => setAutoCashoutEnabled(!autoCashoutEnabled)}
                className={`relative w-11 h-6 rounded-full transition-colors ${
                  autoCashoutEnabled ? 'bg-green-500' : 'bg-red-500'
                }`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                  autoCashoutEnabled ? 'translate-x-5' : 'translate-x-0'
                }`} />
              </button>
            </div>

            {autoCashoutEnabled && (
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    const v = Math.max(1.1, parseFloat(autoCashoutValue) - 0.1)
                    setAutoCashoutValue(v.toFixed(1))
                  }}
                  className="w-10 h-10 rounded-lg bg-neutral-800 border border-neutral-700 text-white text-lg font-bold flex items-center justify-center hover:bg-neutral-700"
                >
                  −
                </button>
                <input
                  type="number"
                  value={autoCashoutValue}
                  onChange={(e) => setAutoCashoutValue(e.target.value)}
                  step="0.1"
                  min="1.01"
                  className="flex-1 bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-white text-center text-lg font-semibold focus:outline-none focus:border-neutral-500"
                />
                <button
                  onClick={() => {
                    const v = parseFloat(autoCashoutValue) + 0.1
                    setAutoCashoutValue(v.toFixed(1))
                  }}
                  className="w-10 h-10 rounded-lg bg-neutral-800 border border-neutral-700 text-white text-lg font-bold flex items-center justify-center hover:bg-neutral-700"
                >
                  +
                </button>
              </div>
            )}

            <button
              onClick={() => setSettingsOpen(false)}
              className="w-full bg-white text-black font-bold rounded-lg py-3 text-base"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
