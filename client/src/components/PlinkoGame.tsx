import { useEffect, useRef, useState, useCallback, useLayoutEffect } from 'react'
import { Settings2 } from 'lucide-react'
import { startPlinko, settlePlinko } from '../lib/api'
import { useApp } from '../context/AppContext'
import PlinkoEngine from '../lib/plinko/PlinkoEngine'
import { binPayouts, autoBetIntervalMs, rowCountOptions } from '../lib/plinko/constants'
import { RiskLevel, BetMode, type RowCount, type WinRecord } from '../lib/plinko/types'
import { BinsRow } from './plinko/BinsRow'
import { MenuPanel } from './plinko/MenuPanel'

interface BallTicketInfo {
  ticketId: string
  bet: number
  rowCount: RowCount
  riskLevel: RiskLevel
}

let winIdCounter = 0

export function PlinkoGame() {
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
  const [, setWinRecords] = useState<WinRecord[]>([])
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
    let ballPath: number[]
    try {
      const res = await startPlinko(bet, rc, riskName)
      ticketId = res.ticketId
      ballPath = res.path
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
    const ballId = engine.dropBall(ballPath)

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
    <div className="h-full w-full bg-[#0e1117] flex flex-col overflow-hidden relative min-h-0">
      {/* Board + bins — same vertical share as Rocket chart so wide screens don’t stretch the canvas to the full viewport width (which made it taller than the screen and hid controls). */}
      <div className="shrink-0 flex flex-col px-3 pt-3 pb-2 min-h-0" style={{ height: '55%' }}>
        <div className="flex flex-col h-full min-h-0 items-center w-full">
          <div className="flex-1 min-h-0 w-full flex items-center justify-center">
            <canvas
              ref={canvasRef}
              width={760}
              height={570}
              className="block max-h-full w-auto max-w-full"
            />
          </div>
          {canvasWidth > 0 && (
            <div className="mt-0.5 shrink-0 w-full flex justify-center">
              <div style={{ width: canvasWidth }}>
                <BinsRow
                  rowCount={rowCount}
                  riskLevel={riskLevel}
                  binsWidthPercent={binsWidth}
                  lastWinBinIndex={lastWinBinIndex}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Controls — scroll if needed (mirrors Rocket bottom section) */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col">
        <div className="shrink-0 w-full border-t border-neutral-800 pt-3">
          <div className="flex flex-col gap-3 px-3 pb-3">
            {/* Row 1 — bet + rows + settings (Rocket-style) */}
            <div className="flex gap-3">
              <div className="flex-1 flex flex-col gap-1 min-w-0">
                <label className="text-neutral-400 text-xs font-medium uppercase tracking-wide">
                  Bet Amount
                </label>
                <input
                  type="number"
                  value={betAmount}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value)
                    setBetAmount(isNaN(v) ? 0 : v)
                  }}
                  disabled={isAutoRunning || controlsLocked}
                  min={minBet}
                  max={maxBet}
                  className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-white text-base focus:outline-none focus:border-neutral-500 disabled:opacity-50"
                />
              </div>
              <div className="flex-1 flex flex-col gap-1 min-w-0">
                <label className="text-neutral-400 text-xs font-medium uppercase tracking-wide">
                  Rows
                </label>
                <div className="flex gap-1.5">
                  <select
                    value={rowCount}
                    onChange={(e) => setRowCount(Number(e.target.value) as RowCount)}
                    disabled={controlsLocked}
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-white text-base focus:outline-none focus:border-neutral-500 disabled:opacity-50 appearance-none"
                  >
                    {rowCountOptions.map((rc) => (
                      <option key={rc} value={rc}>
                        {rc}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setMenuOpen(true)}
                    className="shrink-0 w-10 h-10 flex items-center justify-center rounded-lg border border-neutral-700 bg-neutral-900 text-white hover:bg-neutral-800 transition-colors"
                  >
                    <Settings2 size={16} strokeWidth={2} />
                  </button>
                </div>
              </div>
            </div>

            {apiError && <p className="text-red-400 text-xs -mt-1">{apiError}</p>}

            {/* Row 2 — quick amounts */}
            <div className="flex gap-2">
              {[10, 50, 100, 500].map((amount) => (
                <button
                  key={amount}
                  type="button"
                  onClick={() => setBetAmount(amount)}
                  disabled={isAutoRunning || controlsLocked}
                  className="flex-1 bg-neutral-900 border border-neutral-700 text-white text-sm font-medium rounded-lg py-2 hover:border-neutral-600 disabled:opacity-50"
                >
                  {amount}
                </button>
              ))}
            </div>

            {/* Row 3 — primary action */}
            <button
              type="button"
              onClick={isAutoRunning ? stopAuto : handleDrop}
              disabled={!isAutoRunning && dropDisabled}
              className={
                isAutoRunning
                  ? 'w-full bg-yellow-500 text-black font-bold rounded-lg py-3 text-base hover:bg-yellow-400 disabled:opacity-50'
                  : 'w-full bg-white text-black font-bold rounded-lg py-3 text-base hover:bg-neutral-100 disabled:opacity-50 disabled:cursor-not-allowed'
              }
            >
              {isAutoRunning ? 'Stop' : 'Drop'}
            </button>
          </div>
        </div>
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
