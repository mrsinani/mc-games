import { X } from 'lucide-react'
import { RiskLevel, BetMode, type RowCount, rowCountOptions } from '../../lib/plinko/types'

interface MenuPanelProps {
  open: boolean
  onClose: () => void
  betAmount: number
  setBetAmount: (v: number) => void
  riskLevel: RiskLevel
  setRiskLevel: (v: RiskLevel) => void
  rowCount: RowCount
  setRowCount: (v: RowCount) => void
  betMode: BetMode
  setBetMode: (v: BetMode) => void
  autoBetCount: number
  setAutoBetCount: (v: number) => void
  onDrop: () => void
  onStartAuto: () => void
  onStopAuto: () => void
  isAutoRunning: boolean
  hasBallsInFlight: boolean
  dropDisabled: boolean
  minBet: number
  maxBet: number
}

export function MenuPanel({
  open,
  onClose,
  betAmount,
  setBetAmount,
  riskLevel,
  setRiskLevel,
  rowCount,
  setRowCount,
  betMode,
  setBetMode,
  autoBetCount,
  setAutoBetCount,
  onDrop,
  onStartAuto,
  onStopAuto,
  isAutoRunning,
  hasBallsInFlight,
  dropDisabled,
  minBet,
  maxBet,
}: MenuPanelProps) {
  const controlsLocked = hasBallsInFlight || isAutoRunning

  function handleBetAction() {
    if (betMode === BetMode.MANUAL) {
      onDrop()
    } else if (!isAutoRunning) {
      onStartAuto()
    } else {
      onStopAuto()
    }
  }

  function getBetLabel() {
    if (betMode === BetMode.MANUAL) return 'Drop Ball'
    if (!isAutoRunning) return 'Start Autobet'
    return 'Stop Autobet'
  }

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 transition-opacity"
          onClick={onClose}
        />
      )}

      {/* Drawer */}
      <div
        className={`fixed left-0 top-0 z-50 h-full w-72 sm:w-80 bg-slate-700 transform transition-transform duration-200 ease-out flex flex-col ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-600">
          <span className="text-white font-semibold text-sm">Settings</span>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-300 hover:bg-slate-600 hover:text-white transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex flex-col gap-4 p-4 overflow-y-auto flex-1">
          {/* Manual / Auto toggle */}
          <div className="flex gap-1 rounded-full bg-slate-900 p-1">
            {([BetMode.MANUAL, BetMode.AUTO] as const).map((mode) => (
              <button
                key={mode}
                disabled={isAutoRunning}
                onClick={() => setBetMode(mode)}
                className={`flex-1 rounded-full py-2 text-sm font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  betMode === mode
                    ? 'bg-slate-600'
                    : 'hover:bg-slate-600/50 active:bg-slate-500'
                }`}
              >
                {mode === BetMode.MANUAL ? 'Manual' : 'Auto'}
              </button>
            ))}
          </div>

          {/* Bet Amount */}
          <div>
            <label className="text-sm font-medium text-slate-300 block mb-1">Bet Amount</label>
            <div className="flex">
              <div className="relative flex-1">
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
                  step="1"
                  className="w-full rounded-l-md border-2 border-slate-600 bg-slate-900 py-2 pr-2 pl-7 text-sm text-white transition-colors hover:border-slate-500 focus:border-slate-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                />
                <div className="absolute top-2 left-3 text-slate-500 select-none">$</div>
              </div>
              <button
                disabled={isAutoRunning}
                onClick={() => setBetAmount(Math.max(minBet, Math.floor(betAmount / 2)))}
                className="bg-slate-600 px-3 font-bold text-white text-sm transition-colors hover:bg-slate-500 active:bg-slate-400 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                ½
              </button>
              <button
                disabled={isAutoRunning}
                onClick={() => setBetAmount(Math.min(maxBet, betAmount * 2))}
                className="rounded-r-md bg-slate-600 px-3 text-sm font-bold text-white transition-colors border-l-2 border-slate-800 hover:bg-slate-500 active:bg-slate-400 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                2×
              </button>
            </div>
          </div>

          {/* Risk */}
          <div>
            <label className="text-sm font-medium text-slate-300 block mb-1">Risk</label>
            <select
              value={riskLevel}
              onChange={(e) => setRiskLevel(e.target.value as RiskLevel)}
              disabled={controlsLocked}
              className="w-full rounded-md border-2 border-slate-600 bg-slate-900 py-2 px-3 text-sm text-white transition-colors hover:border-slate-500 focus:border-slate-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed appearance-none"
            >
              <option value={RiskLevel.LOW}>Low</option>
              <option value={RiskLevel.MEDIUM}>Medium</option>
              <option value={RiskLevel.HIGH}>High</option>
            </select>
          </div>

          {/* Rows */}
          <div>
            <label className="text-sm font-medium text-slate-300 block mb-1">Rows</label>
            <select
              value={rowCount}
              onChange={(e) => setRowCount(Number(e.target.value) as RowCount)}
              disabled={controlsLocked}
              className="w-full rounded-md border-2 border-slate-600 bg-slate-900 py-2 px-3 text-sm text-white transition-colors hover:border-slate-500 focus:border-slate-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed appearance-none"
            >
              {rowCountOptions.map((rc) => (
                <option key={rc} value={rc}>
                  {rc}
                </option>
              ))}
            </select>
          </div>

          {/* Auto bet count */}
          {betMode === BetMode.AUTO && (
            <div>
              <label className="text-sm font-medium text-slate-300 block mb-1">
                Number of Bets
                <span className="text-slate-500 text-xs ml-1">(0 = unlimited)</span>
              </label>
              <input
                type="number"
                value={autoBetCount}
                onChange={(e) => {
                  const v = parseInt(e.target.value)
                  setAutoBetCount(isNaN(v) ? 0 : Math.max(0, v))
                }}
                disabled={isAutoRunning}
                min={0}
                className="w-full rounded-md border-2 border-slate-600 bg-slate-900 py-2 px-3 text-sm text-white transition-colors hover:border-slate-500 focus:border-slate-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
              />
            </div>
          )}

          {/* Drop / Auto button */}
          <button
            onClick={handleBetAction}
            disabled={betMode === BetMode.MANUAL ? dropDisabled : false}
            className={`w-full rounded-md py-3 font-semibold text-slate-900 transition-colors disabled:bg-neutral-600 disabled:text-neutral-400 ${
              isAutoRunning
                ? 'bg-yellow-500 hover:bg-yellow-400 active:bg-yellow-600'
                : 'bg-green-500 hover:bg-green-400 active:bg-green-600'
            }`}
          >
            {getBetLabel()}
          </button>
        </div>
      </div>
    </>
  )
}
