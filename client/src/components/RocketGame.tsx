import { useEffect, useRef, useState, useCallback } from 'react'
import { io as socketIo, Socket } from 'socket.io-client'
import { rocketPlaceBet, rocketCashout } from '../lib/api'
import { useApp } from '../context/AppContext'

interface RocketGameProps {
  onBack: () => void
}

type GamePhase = 'betting' | 'flight' | 'crash' | 'cooldown'

interface RoundOpenPayload {
  roundId: string
  serverSeedHash: string
  previousServerSeed: string | null
}

interface MultiplierTickPayload {
  multiplier: number
  roundId?: string
}

interface RoundCrashPayload {
  crashPoint: number
  roundId: string
  revealedSeed: string | null
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

  const socketRef = useRef<Socket | null>(null)
  const hasActiveBetRef = useRef(false)
  const cashedOutRef = useRef(false)
  const currentRoundIdRef = useRef<string>('')

  // Keep refs in sync
  hasActiveBetRef.current = hasActiveBet
  cashedOutRef.current = cashedOut

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
  }, [])

  const handleRoundLaunch = useCallback(() => {
    setPhase('flight')
  }, [])

  const handleMultiplierTick = useCallback((payload: MultiplierTickPayload) => {
    if (payload.roundId !== undefined && payload.roundId !== currentRoundIdRef.current) return
    setMultiplier(payload.multiplier)
  }, [])

  const handleRoundCrash = useCallback((payload: RoundCrashPayload) => {
    if (payload.roundId !== currentRoundIdRef.current) return
    setPhase('crash')
    setCrashedAt(payload.crashPoint)
    setMultiplier(payload.crashPoint)
    setFlashRed(true)
    setTimeout(() => setFlashRed(false), 600)

    // Determine if user lost
    if (hasActiveBetRef.current && !cashedOutRef.current) {
      setLostRound(true)
    }
  }, [])

  const handleCashoutConfirmed = useCallback((payload: CashoutConfirmedPayload) => {
    setCashedOut(true)
    setCashoutResult({ cashoutAt: payload.cashoutAt, payout: payload.payout })
    setBalance(payload.newBalance)
  }, [setBalance])

  const handleRoundState = useCallback((payload: RoundStatePayload) => {
    setPhase(payload.phase)
    setMultiplier(payload.multiplier)
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

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [user?.telegram_id, handleRoundOpen, handleRoundLaunch, handleMultiplierTick, handleRoundCrash, handleCashoutConfirmed, handleRoundState])

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
    switch (phase) {
      case 'betting':
        return 'Betting open'
      case 'flight':
        return 'Flying...'
      case 'crash':
        return `Crashed at ${crashedAt?.toFixed(2)}x`
      case 'cooldown':
        return 'Next round starting...'
    }
  }

  function getMultiplierColor(): string {
    if (phase === 'crash') return 'text-neutral-500'
    if (phase === 'flight' && multiplier >= 2) return 'text-white'
    return 'text-white'
  }

  return (
    <div className="h-dvh bg-black flex flex-col overflow-hidden">
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

      {/* Main game area */}
      <div
        className={`flex-1 flex flex-col items-center justify-center px-6 transition-opacity duration-150 ${
          flashRed ? 'opacity-40' : 'opacity-100'
        }`}
      >
        {/* Rocket animation */}
        <div
          className={`text-6xl mb-6 transition-transform duration-100 ${
            phase === 'flight' ? 'animate-bounce' : ''
          }`}
          style={{
            transform: phase === 'crash' ? 'rotate(45deg)' : 'none',
          }}
        >
          🚀
        </div>

        {/* Multiplier display */}
        <div className={`text-7xl font-black tabular-nums tracking-tight ${getMultiplierColor()}`}>
          {displayMultiplier}x
        </div>

        {/* Status text */}
        <p className="text-neutral-400 text-base mt-3">{getStatusText()}</p>

        {/* Round result feedback */}
        {phase === 'crash' && hasActiveBet && (
          <div className="mt-6 text-center">
            {cashedOut && cashoutResult ? (
              <div className="bg-neutral-900 border border-neutral-700 rounded-xl px-6 py-4">
                <p className="text-white font-bold text-xl">+{cashoutResult.payout} coins</p>
                <p className="text-neutral-400 text-sm mt-1">Cashed out at {cashoutResult.cashoutAt.toFixed(2)}x</p>
              </div>
            ) : lostRound ? (
              <div className="bg-neutral-900 border border-neutral-800 rounded-xl px-6 py-4">
                <p className="text-neutral-400 font-semibold text-lg">Crashed</p>
                <p className="text-neutral-500 text-sm mt-1">Better luck next round</p>
              </div>
            ) : null}
          </div>
        )}

        {/* Flight cashout result */}
        {phase === 'flight' && cashedOut && cashoutResult && (
          <div className="mt-6 bg-neutral-900 border border-neutral-700 rounded-xl px-6 py-4 text-center">
            <p className="text-white font-bold text-xl">+{cashoutResult.payout} coins</p>
            <p className="text-neutral-400 text-sm mt-1">Cashed out at {cashoutResult.cashoutAt.toFixed(2)}x</p>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="shrink-0 flex flex-col gap-4 p-4 border-t border-neutral-800">
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
            <p className="text-neutral-400 text-sm mt-1">Waiting for round to start...</p>
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
              {phase === 'cooldown' ? 'Next round starting...' : 'Betting opens next round'}
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
