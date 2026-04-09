import { useEffect, useRef, useState, useCallback, useLayoutEffect } from 'react'
import { ArrowLeft, Settings } from 'lucide-react'
import { startPlinko, settlePlinko } from '../lib/api'
import { useApp } from '../context/AppContext'
import PlinkoEngine from '../lib/plinko/PlinkoEngine'
import { binPayouts, autoBetIntervalMs, rowCountOptions } from '../lib/plinko/constants'
import { RiskLevel, BetMode, type RowCount, type WinRecord } from '../lib/plinko/types'
import { BinsRow } from './plinko/BinsRow'
import { LastWins } from './plinko/LastWins'
import { MenuPanel } from './plinko/MenuPanel'

interface PlinkoGameProps {
  onBack: () => void
}

interface BallTicketInfo {
  ticketId: string
  bet: number
  rowCount: RowCount
  riskLevel: RiskLevel
}

let winIdCounter = 0

export function PlinkoGame({ onBack }: PlinkoGameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<PlinkoEngine | null>(null)
  const { user, setBalance, config } = useApp()

  const minBet = Math.max(1, Number(config?.['min_bet']) || 1)
  const maxBet = Math.max(minBet, Number(config?.['max_bet']) || 10000)

  const [menuOpen, setMenuOpen] = useState(false)
  const [betAmount, setBetAmount] = useState(minBet)
  const [riskLevel, setRiskLevel] = useState(RiskLevel.LOW)
  const [rowCount, setRowCount] = useState<RowCount>(16)
  const [betMode, setBetMode] = useState(BetMode.MANUAL)
  const [autoBetCount, setAutoBetCount] = useState(0)
  const [isAutoRunning, setIsAutoRunning] = useState(false)
  const [winRecords, setWinRecords] = useState<WinRecord[]>([])
  const [lastWinBinIndex, setLastWinBinIndex] = useState<number | null>(null)
  const [binsWidth, setBinsWidth] = useState(0.8)
  const [ballsInFlight, setBallsInFlight] = useState(0)
  const [apiError, setApiError] = useState<string | null>(null)
  const [canvasWidth, setCanvasWidth] = useState(0)

  const autoIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const autoBetsLeftRef = useRef<number | null>(null)
  // Optimistic balance that debits instantly on drop, before server confirms.
  const displayBalanceRef = useRef(user?.balance ?? 0)

  // Ticket info per ball — used to settle when the ball lands
  const ballTickets = useRef<Map<number, BallTicketInfo>>(new Map())

  const betAmountRef = useRef(betAmount)
  const riskLevelRef = useRef(riskLevel)
  const rowCountRef = useRef(rowCount)
  betAmountRef.current = betAmount
  riskLevelRef.current = riskLevel
  rowCountRef.current = rowCount

  // Sync optimistic balance from server when idle (no balls in flight)
  useEffect(() => {
    if (ballsInFlight === 0 && user) {
      displayBalanceRef.current = user.balance
    }
  }, [ballsInFlight, user?.balance])

  // Stable ref so engine never needs recreation when deps change
  const ballLandRef = useRef((_event: { ballId: number; binIndex: number }) => {})
  ballLandRef.current = (event: { ballId: number; binIndex: number }) => {
    setBallsInFlight((prev) => Math.max(0, prev - 1))

    const info = ballTickets.current.get(event.ballId)
    ballTickets.current.delete(event.ballId)

    if (!info) {
      setLastWinBinIndex(event.binIndex)
      return
    }

    // Show result immediately from client-side payout table
    const multiplier = binPayouts[info.rowCount][info.riskLevel][event.binIndex]
    const payoutValue = Math.floor(info.bet * (multiplier ?? 0))
    const record: WinRecord = {
      id: String(++winIdCounter),
      betAmount: info.bet,
      rowCount: info.rowCount,
      binIndex: event.binIndex,
      payout: { multiplier: multiplier ?? 0, value: payoutValue },
      profit: payoutValue - info.bet,
    }

    setLastWinBinIndex(event.binIndex)
    displayBalanceRef.current += payoutValue
    setBalance(displayBalanceRef.current)
    setWinRecords((prev) => [...prev.slice(-50), record])

    // Settle with server in background using the ticket
    settlePlinko(info.ticketId, event.binIndex)
      .then((res) => {
        // Server balance is authoritative
        displayBalanceRef.current = res.newBalance
        setBalance(res.newBalance)
      })
      .catch((err) => {
        setApiError(err instanceof Error ? err.message : 'Settlement failed')
      })
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const engine = new PlinkoEngine({
      canvas,
      rowCount,
      onBallLand: (event) => ballLandRef.current(event),
    })
    engine.start()
    engineRef.current = engine
    setBinsWidth(engine.binsWidthPercentage)

    return () => {
      engine.destroy()
      engineRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(([entry]) => {
      setCanvasWidth(entry.contentRect.width)
    })
    ro.observe(canvas)
    setCanvasWidth(canvas.clientWidth)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    engine.updateRowCount(rowCount)
    setBinsWidth(engine.binsWidthPercentage)
  }, [rowCount])

  const dropOneBall = useCallback(async () => {
    const bet = betAmountRef.current
    const rc = rowCountRef.current
    const rl = riskLevelRef.current

    if (bet < minBet || bet > maxBet) return

    // Optimistic balance check & debit
    if (bet > displayBalanceRef.current) return
    displayBalanceRef.current -= bet
    setBalance(displayBalanceRef.current)

    setApiError(null)
    setBallsInFlight((prev) => prev + 1)

    // Get a ticket from the server (bet is debited server-side here)
    const riskName = rl === RiskLevel.LOW ? 'LOW'
      : rl === RiskLevel.MEDIUM ? 'MEDIUM' : 'HIGH'

    let ticketId: string
    try {
      const res = await startPlinko(bet, rc, riskName)
      ticketId = res.ticketId
      // Sync with server's confirmed balance
      displayBalanceRef.current = res.newBalance
      setBalance(res.newBalance)
    } catch (err) {
      // Refund the optimistic debit on failure
      displayBalanceRef.current += bet
      setBalance(displayBalanceRef.current)
      setBallsInFlight((prev) => Math.max(0, prev - 1))
      setApiError(err instanceof Error ? err.message : 'Failed to place bet')
      return
    }

    const engine = engineRef.current
    if (!engine) return
    const ballId = engine.dropBall()

    // Store ticket so we can settle when ball lands
    ballTickets.current.set(ballId, { ticketId, bet, rowCount: rc, riskLevel: rl })
  }, [minBet, maxBet, setBalance])

  const stopAuto = useCallback(() => {
    if (autoIntervalRef.current) {
      clearInterval(autoIntervalRef.current)
      autoIntervalRef.current = null
    }
    setIsAutoRunning(false)
  }, [])

  const startAuto = useCallback(() => {
    autoBetsLeftRef.current = autoBetCount === 0 ? null : autoBetCount
    setIsAutoRunning(true)

    const tick = async () => {
      if (autoBetsLeftRef.current !== null) {
        if (autoBetsLeftRef.current <= 0) {
          stopAuto()
          return
        }
        autoBetsLeftRef.current -= 1
      }
      await dropOneBall()
    }

    autoIntervalRef.current = setInterval(tick, autoBetIntervalMs)
  }, [autoBetCount, dropOneBall, stopAuto])

  useEffect(() => {
    return () => {
      if (autoIntervalRef.current) clearInterval(autoIntervalRef.current)
    }
  }, [])

  const handleDrop = useCallback(() => {
    dropOneBall()
  }, [dropOneBall])

  const controlsLocked = ballsInFlight > 0 || isAutoRunning
  const dropDisabled =
    betAmount < minBet ||
    betAmount > maxBet ||
    (user ? betAmount > user.balance : false)

  return (
    <div className="h-dvh bg-gray-900 flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="shrink-0 flex items-center justify-between px-3 py-2 bg-gray-900/80 backdrop-blur-sm border-b border-white/5">
        <button
          onClick={onBack}
          className="p-2 rounded-lg text-white hover:bg-white/10 transition-colors"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="text-white font-semibold text-sm">
          ${user?.balance.toLocaleString() ?? '0'}
        </div>
        <button
          onClick={() => setMenuOpen(true)}
          className="p-2 rounded-lg text-slate-400 hover:bg-white/10 hover:text-white transition-colors"
          title="Auto-bet settings"
        >
          <Settings size={18} />
        </button>
      </div>

      {/* Game area */}
      <div className="flex-1 relative flex items-center justify-center min-h-0 overflow-hidden px-3 py-3">
        {/* Canvas + bins column */}
        <div className="flex flex-col items-center min-w-0 max-h-full">
          <canvas
            ref={canvasRef}
            width={760}
            height={570}
            className="block max-w-full max-h-[calc(100dvh-200px)]"
            style={{ aspectRatio: '760 / 570' }}
          />
          {canvasWidth > 0 && (
            <div className="mt-0.5" style={{ width: canvasWidth }}>
              <BinsRow
                rowCount={rowCount}
                riskLevel={riskLevel}
                binsWidthPercent={binsWidth}
                lastWinBinIndex={lastWinBinIndex}
              />
            </div>
          )}
        </div>
        <div className="absolute right-3 top-3 hidden sm:block w-12">
          <LastWins wins={winRecords} />
        </div>
        {apiError && (
          <p className="absolute bottom-16 left-0 right-0 text-red-400 text-xs text-center">{apiError}</p>
        )}
      </div>

      {/* Bottom controls */}
      <div className="shrink-0 bg-slate-800 border-t border-white/5 px-2 py-2 flex gap-1.5 items-center">
        <select
          value={riskLevel}
          onChange={(e) => setRiskLevel(e.target.value as RiskLevel)}
          disabled={controlsLocked}
          className="shrink-0 w-16 rounded-md border border-slate-600 bg-slate-900 py-2 px-1.5 text-xs text-white focus:outline-none disabled:opacity-40 appearance-none"
        >
          <option value={RiskLevel.LOW}>Low</option>
          <option value={RiskLevel.MEDIUM}>Med</option>
          <option value={RiskLevel.HIGH}>High</option>
        </select>

        <select
          value={rowCount}
          onChange={(e) => setRowCount(Number(e.target.value) as RowCount)}
          disabled={controlsLocked}
          className="shrink-0 w-14 rounded-md border border-slate-600 bg-slate-900 py-2 px-1.5 text-xs text-white focus:outline-none disabled:opacity-40 appearance-none"
        >
          {rowCountOptions.map((rc) => (
            <option key={rc} value={rc}>{rc}</option>
          ))}
        </select>

        <div className="flex flex-1 min-w-0">
          <div className="relative flex-1 min-w-0">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 text-xs select-none">$</span>
            <input
              type="number"
              value={betAmount}
              onChange={(e) => {
                const v = parseFloat(e.target.value)
                setBetAmount(isNaN(v) ? 0 : v)
              }}
              disabled={isAutoRunning}
              min={minBet}
              max={maxBet}
              className="w-full rounded-l-md border border-slate-600 bg-slate-900 py-2 pl-6 pr-1 text-xs text-white focus:outline-none disabled:opacity-40"
            />
          </div>
          <button
            disabled={isAutoRunning}
            onClick={() => setBetAmount(Math.max(minBet, Math.floor(betAmount / 2)))}
            className="bg-slate-700 px-2 text-xs font-bold text-white border-y border-slate-600 hover:bg-slate-600 active:bg-slate-500 disabled:opacity-40"
          >
            ½
          </button>
          <button
            disabled={isAutoRunning}
            onClick={() => setBetAmount(Math.min(maxBet, betAmount * 2))}
            className="bg-slate-700 px-2 text-xs font-bold text-white rounded-r-md border border-slate-600 border-l-0 hover:bg-slate-600 active:bg-slate-500 disabled:opacity-40"
          >
            2×
          </button>
        </div>

        <button
          onClick={isAutoRunning ? stopAuto : handleDrop}
          disabled={!isAutoRunning && dropDisabled}
          className={`shrink-0 rounded-md px-5 py-2 font-semibold text-xs transition-colors disabled:bg-neutral-700 disabled:text-neutral-500 ${
            isAutoRunning
              ? 'bg-yellow-500 text-slate-900 hover:bg-yellow-400'
              : 'bg-green-500 text-slate-900 hover:bg-green-400'
          }`}
        >
          {isAutoRunning ? 'Stop' : 'Drop'}
        </button>
      </div>

      <MenuPanel
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        betAmount={betAmount}
        setBetAmount={setBetAmount}
        riskLevel={riskLevel}
        setRiskLevel={setRiskLevel}
        rowCount={rowCount}
        setRowCount={setRowCount}
        betMode={betMode}
        setBetMode={setBetMode}
        autoBetCount={autoBetCount}
        setAutoBetCount={setAutoBetCount}
        onDrop={handleDrop}
        onStartAuto={startAuto}
        onStopAuto={stopAuto}
        isAutoRunning={isAutoRunning}
        hasBallsInFlight={ballsInFlight > 0}
        dropDisabled={dropDisabled}
        minBet={minBet}
        maxBet={maxBet}
      />
    </div>
  )
}
