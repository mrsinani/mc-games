import { useEffect, useRef, useState, useCallback } from 'react'
import { io as socketIo, Socket } from 'socket.io-client'
import { rocketPlaceBet, rocketCashout } from '../lib/api'
import { useApp } from '../context/AppContext'

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

  // Accumulate multiplier ticks during flight
  useEffect(() => {
    if (phase === 'betting' || phase === 'cooldown') {
      historyRef.current = [1]
    } else if (phase === 'flight') {
      if (historyRef.current.length <= 1 && multiplier > 1.01 && elapsedMs > 200) {
        // Mid-round join: reconstruct curve using the server's formula
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

  // Canvas draw loop
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    function draw() {
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
      const crashed = phase === 'crash'

      // ── background ──
      ctx!.clearRect(0, 0, w, h)

      // dark card background
      const bgRadius = 16
      ctx!.beginPath()
      ctx!.roundRect(0, 0, w, h, bgRadius)
      ctx!.fillStyle = '#1a1d26'
      ctx!.fill()

      const pad = { l: 48, r: 16, t: 20, b: 36 }
      const chartW = w - pad.l - pad.r
      const chartH = h - pad.t - pad.b

      // ── y-axis scale ──
      const maxMul = Math.max(2, ...history) * 1.15
      const toY = (v: number) => pad.t + chartH - ((v - 1) / (maxMul - 1)) * chartH
      const toX = (i: number) => pad.l + (pts > 1 ? (i / (pts - 1)) * chartW : chartW / 2)

      // ── y-axis grid lines + labels (left side) ──
      const gridSteps = getGridSteps(maxMul)
      for (const v of gridSteps) {
        const y = toY(v)
        if (y < pad.t || y > pad.t + chartH) continue
        // grid line
        ctx!.strokeStyle = 'rgba(255,255,255,0.07)'
        ctx!.lineWidth = 1
        ctx!.setLineDash([3, 3])
        ctx!.beginPath()
        ctx!.moveTo(pad.l, y)
        ctx!.lineTo(w - pad.r, y)
        ctx!.stroke()
        ctx!.setLineDash([])
        // label
        ctx!.font = '12px ui-monospace, monospace'
        ctx!.textAlign = 'right'
        ctx!.fillStyle = 'rgba(255,255,255,0.4)'
        ctx!.fillText(`${v.toFixed(1)}x`, pad.l - 8, y + 4)
      }
      // always draw 1.0x at baseline
      const baseY = toY(1)
      ctx!.font = '12px ui-monospace, monospace'
      ctx!.textAlign = 'right'
      ctx!.fillStyle = 'rgba(255,255,255,0.4)'
      ctx!.fillText('1.0x', pad.l - 8, baseY + 4)

      // ── x-axis time labels ──
      const totalSec = elapsedMs / 1000
      const timeSteps = getTimeSteps(totalSec)
      ctx!.font = '11px ui-monospace, monospace'
      ctx!.textAlign = 'center'
      ctx!.fillStyle = 'rgba(255,255,255,0.35)'
      for (const t of timeSteps) {
        const frac = totalSec > 0 ? t / totalSec : 0
        const x = pad.l + frac * chartW
        if (x < pad.l + 20 || x > w - pad.r - 10) continue
        ctx!.fillText(`${Math.round(t)}s`, x, h - 8)
        // small tick mark
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

      // ── gradient fill under curve (solid orange) ──
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

      // ── line (white / red on crash) ──
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

      // ── head dot ──
      const lastX = toX(pts - 1)
      const lastY = toY(history[pts - 1])

      if (!crashed) {
        // outer glow
        ctx!.beginPath()
        ctx!.arc(lastX, lastY, 12, 0, Math.PI * 2)
        ctx!.fillStyle = 'rgba(255,255,255,0.15)'
        ctx!.fill()
        // white dot
        ctx!.beginPath()
        ctx!.arc(lastX, lastY, 6, 0, Math.PI * 2)
        ctx!.fillStyle = '#ffffff'
        ctx!.fill()
      }

      // ── cashout marker ──
      if (cashedOutAt !== null && cashedOutAt > 1) {
        const cY = toY(cashedOutAt)
        let cIdx = history.findIndex((v) => v >= cashedOutAt)
        if (cIdx === -1) cIdx = pts - 1
        const cX = toX(cIdx)
        // dashed horizontal line
        ctx!.setLineDash([4, 4])
        ctx!.strokeStyle = 'rgba(255,255,255,0.3)'
        ctx!.lineWidth = 1
        ctx!.beginPath()
        ctx!.moveTo(pad.l, cY)
        ctx!.lineTo(w - pad.r, cY)
        ctx!.stroke()
        ctx!.setLineDash([])
        // marker dot
        ctx!.beginPath()
        ctx!.arc(cX, cY, 7, 0, Math.PI * 2)
        ctx!.fillStyle = '#ffffff'
        ctx!.fill()
        ctx!.beginPath()
        ctx!.arc(cX, cY, 4, 0, Math.PI * 2)
        ctx!.fillStyle = '#22c55e'
        ctx!.fill()
      }

      // ── crash X marker ──
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

      // ── multiplier text overlaid on chart ──
      const mulText = `${(crashed ? crashedAt! : multiplier).toFixed(2)}x`
      const fontSize = Math.min(w * 0.18, 72)
      ctx!.font = `900 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
      ctx!.textAlign = 'center'
      ctx!.textBaseline = 'middle'
      // position: center of chart area, shifted a bit toward bottom-left
      const textX = pad.l + chartW * 0.45
      const textY = pad.t + chartH * 0.55
      // shadow for readability
      ctx!.fillStyle = 'rgba(0,0,0,0.4)'
      ctx!.fillText(mulText, textX + 2, textY + 2)
      ctx!.fillStyle = crashed ? '#ef4444' : '#ffffff'
      ctx!.fillText(mulText, textX, textY)

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [phase, multiplier, crashedAt, cashedOutAt, elapsedMs])

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

interface RocketGameProps {
  onBack: () => void
}

type GamePhase = 'betting' | 'flight' | 'crash' | 'cooldown'

interface RoundOpenPayload {
  roundId: string
  serverSeedHash: string
  previousServerSeed: string | null
  bettingDurationMs?: number
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
}

export function RocketGame({ onBack }: RocketGameProps) {
  const { user, setBalance, config } = useApp()

  const minBet = Math.max(1, Number(config?.['min_bet']) || 10)
  const maxBet = Math.max(minBet, Number(config?.['max_bet']) || 10000)

  const [phase, setPhase] = useState<GamePhase>('cooldown')
  const [multiplier, setMultiplier] = useState(1.00)
  const [crashedAt, setCrashedAt] = useState<number | null>(null)
  const [bet, setBet] = useState(minBet)
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

  const socketRef = useRef<Socket | null>(null)
  const hasActiveBetRef = useRef(false)
  const cashedOutRef = useRef(false)
  const currentRoundIdRef = useRef<string>('')
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Keep refs in sync
  hasActiveBetRef.current = hasActiveBet
  cashedOutRef.current = cashedOut

  const startCountdown = useCallback((durationMs: number) => {
    if (countdownRef.current) clearInterval(countdownRef.current)
    const endsAt = Date.now() + durationMs
    setCountdown(Math.ceil(durationMs / 1000))
    countdownRef.current = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000))
      setCountdown(remaining)
      if (remaining <= 0 && countdownRef.current) {
        clearInterval(countdownRef.current)
        countdownRef.current = null
      }
    }, 200)
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
    startCountdown(payload.bettingDurationMs ?? 5000)
  }, [startCountdown])

  const handleRoundLaunch = useCallback(() => {
    setPhase('flight')
    setElapsedMs(0)
    setCountdown(null)
    if (countdownRef.current) {
      clearInterval(countdownRef.current)
      countdownRef.current = null
    }
  }, [])

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
    startCountdown(payload.cooldownDurationMs ?? 3000)

    // Determine if user lost
    if (hasActiveBetRef.current && !cashedOutRef.current) {
      setLostRound(true)
    }
  }, [startCountdown])

  const handleCashoutConfirmed = useCallback((payload: CashoutConfirmedPayload) => {
    setCashedOut(true)
    setCashoutResult({ cashoutAt: payload.cashoutAt, payout: payload.payout })
    setBalance(payload.newBalance)
  }, [setBalance])

  const handleRoundState = useCallback((payload: RoundStatePayload) => {
    currentRoundIdRef.current = payload.roundId
    setPhase(payload.phase)
    setMultiplier(payload.multiplier)
    setCrashedAt(null)
    setElapsedMs(payload.elapsedMs ?? 0)
  }, [])

  const handleBetRestored = useCallback((payload: { bet: number; cashedOut: boolean; cashoutAt: number | null }) => {
    setBet(payload.bet)
    setHasActiveBet(true)
    if (payload.cashedOut && payload.cashoutAt !== null) {
      setCashedOut(true)
      setCashoutResult({ cashoutAt: payload.cashoutAt, payout: Math.floor(payload.bet * payload.cashoutAt) })
    }
  }, [])

  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL as string
    const socket = socketIo(apiUrl, { transports: ['websocket', 'polling'] })
    socketRef.current = socket

    socket.on('connect', () => {
      if (user?.telegram_id) {
        socket.emit('register', { telegramId: user.telegram_id })
      }
    })

    socket.on('round:open', handleRoundOpen)
    socket.on('round:launch', handleRoundLaunch)
    socket.on('multiplier:tick', handleMultiplierTick)
    socket.on('round:crash', handleRoundCrash)
    socket.on('cashout:confirmed', handleCashoutConfirmed)
    socket.on('round:state', handleRoundState)
    socket.on('bet:restored', handleBetRestored)

    return () => {
      socket.disconnect()
      socketRef.current = null
      if (countdownRef.current) {
        clearInterval(countdownRef.current)
        countdownRef.current = null
      }
    }
  }, [user?.telegram_id, handleRoundOpen, handleRoundLaunch, handleMultiplierTick, handleRoundCrash, handleCashoutConfirmed, handleRoundState, handleBetRestored])

  async function handlePlaceBet() {
    if (isPlacingBet || phase !== 'betting') return
    setBetError(null)
    setApiError(null)

    if (bet < minBet || bet > maxBet) {
      setBetError(`Bet must be between ${minBet} and ${maxBet}`)
      return
    }

    setIsPlacingBet(true)
    try {
      const result = await rocketPlaceBet(bet)
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
    try {
      const result = await rocketCashout()
      setCashedOut(true)
      setCashoutResult({ cashoutAt: result.cashoutAt, payout: result.payout })
      setBalance(result.newBalance)
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Failed to cash out')
    } finally {
      setIsCashingOut(false)
    }
  }

  const displayMultiplier = multiplier.toFixed(2)

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
    <div className="h-dvh bg-[#0e1117] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-neutral-800 shrink-0">
        <button
          onClick={onBack}
          className="text-white text-xl leading-none w-8 h-8 flex items-center justify-center rounded-lg hover:bg-neutral-900"
        >
          ←
        </button>
        <h1 className="text-white font-bold text-lg">Rocket</h1>
      </div>

      {/* Chart area */}
      <div className="flex-1 flex flex-col min-h-0 px-3 pt-3 pb-2">
        <div className={`flex-1 min-h-0 transition-opacity duration-150 ${flashRed ? 'opacity-40' : 'opacity-100'}`}>
          {phase === 'flight' || phase === 'crash' ? (
            <CurveChart
              multiplier={multiplier}
              phase={phase}
              crashedAt={crashedAt}
              cashedOutAt={cashoutResult?.cashoutAt ?? null}
              elapsedMs={elapsedMs}
            />
          ) : (
            /* Waiting / betting state — show status in the chart area */
            <div className="w-full h-full rounded-2xl bg-[#1a1d26] flex flex-col items-center justify-center gap-3">
              <p className="text-5xl font-black text-white tabular-nums">{displayMultiplier}x</p>
              <p className="text-neutral-400 text-sm">{getStatusText()}</p>
            </div>
          )}
        </div>

        {/* Round result feedback (overlaid below chart) */}
        {hasActiveBet && (phase === 'crash' || (phase === 'flight' && cashedOut)) && cashoutResult && (
          <div className="mt-2 bg-[#1a1d26] border border-green-800 rounded-xl px-4 py-3 text-center">
            <p className="text-green-400 font-bold text-lg">+{cashoutResult.payout} coins</p>
            <p className="text-neutral-400 text-xs mt-0.5">Cashed out at {cashoutResult.cashoutAt.toFixed(2)}x</p>
          </div>
        )}
        {phase === 'crash' && hasActiveBet && lostRound && !cashedOut && (
          <div className="mt-2 bg-[#1a1d26] border border-red-900 rounded-xl px-4 py-3 text-center">
            <p className="text-red-400 font-semibold">Crashed — you lost {bet} coins</p>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="shrink-0 flex flex-col gap-3 px-3 pb-4 pt-2">
        {/* Betting phase controls */}
        {phase === 'betting' && !hasActiveBet && (
          <>
            <div className="flex flex-col gap-1">
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
              {betError && <p className="text-red-400 text-xs mt-1">{betError}</p>}
            </div>

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
          <div className="bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-3 text-center">
            <p className="text-white font-semibold">Bet placed: {bet} coins</p>
            <p className="text-neutral-400 text-sm mt-1">
              Launching in {countdown !== null && countdown > 0 ? `${countdown}s` : '...'}
            </p>
          </div>
        )}

        {/* Flight phase — cash out button */}
        {phase === 'flight' && hasActiveBet && !cashedOut && (
          <button
            onClick={handleCashout}
            disabled={isCashingOut}
            className="w-full bg-white text-black font-black rounded-xl py-5 text-2xl hover:bg-neutral-100 disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 transition-transform"
          >
            {isCashingOut ? 'Cashing Out...' : `Cash Out ${displayMultiplier}x`}
          </button>
        )}

        {/* Flight phase — watching (no active bet) */}
        {phase === 'flight' && !hasActiveBet && (
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-3 text-center">
            <p className="text-neutral-400 text-sm">Watching — place a bet next round</p>
          </div>
        )}

        {/* Crash/cooldown phase */}
        {(phase === 'crash' || phase === 'cooldown') && !hasActiveBet && (
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-3 text-center">
            <p className="text-neutral-400 text-sm">
              {countdown !== null && countdown > 0
                ? `Next round in ${countdown}s`
                : 'Next round starting...'}
            </p>
          </div>
        )}

        {/* API error */}
        {apiError && (
          <p className="text-red-400 text-sm text-center">{apiError}</p>
        )}
      </div>
    </div>
  )
}
