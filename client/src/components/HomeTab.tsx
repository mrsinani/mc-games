import { useEffect, useState } from 'react'
import { useApp } from '../context/AppContext'
import { getMeStats, addCoins } from '../lib/api'
import { Circle, Rocket, RotateCw, type LucideIcon } from 'lucide-react'
import type { Tab } from './TabBar'

interface GameCardProps {
  icon: LucideIcon
  title: string
  enabled: boolean
  onClick?: () => void
}

function GameCard({ icon: Icon, title, enabled, onClick }: GameCardProps) {
  return (
    <div
      onClick={enabled ? onClick : undefined}
      className={`flex items-center gap-4 bg-neutral-900 border border-neutral-800 rounded-xl p-4 ${
        enabled
          ? 'cursor-pointer hover:border-neutral-700 active:bg-neutral-800'
          : 'opacity-50 cursor-default'
      }`}
    >
      <Icon className="size-6 text-white shrink-0" strokeWidth={1.5} />
      <p className="flex-1 min-w-0 text-white font-semibold">{title}</p>
      {enabled ? (
        <span className="bg-white text-black text-xs font-semibold rounded-lg px-3 py-1 shrink-0">
          Play
        </span>
      ) : (
        <span className="bg-neutral-800 text-neutral-400 text-xs font-semibold rounded-lg px-3 py-1 shrink-0">
          Soon
        </span>
      )}
    </div>
  )
}

interface HomeTabProps {
  onNavigate: (tab: Tab) => void
}

export function HomeTab({ onNavigate }: HomeTabProps) {
  const { user, config, setBalance } = useApp()
  const avatarUrl = user?.photo_url || '/mc_logo.png'
  const [totalWon, setTotalWon] = useState(0)
  const [addingCoins, setAddingCoins] = useState(false)

  const plinkoEnabled = Boolean(config?.plinko_enabled)
  const rocketEnabled = Boolean(config?.rocket_enabled)
  const pvpEnabled = Boolean(config?.pvp_enabled)

  useEffect(() => {
    let isMounted = true
    async function loadStats() {
      try {
        const stats = await getMeStats()
        if (!isMounted) return
        setTotalWon(stats.totalWon ?? 0)
      } catch {
        if (!isMounted) return
        setTotalWon(0)
      }
    }
    void loadStats()
    return () => { isMounted = false }
  }, [])

  async function handleAddCoins() {
    if (addingCoins) return
    setAddingCoins(true)
    try {
      const res = await addCoins()
      setBalance(res.newBalance)
    } catch {
      // silently fail
    } finally {
      setAddingCoins(false)
    }
  }

  return (
    <div className="scrollbar-none flex flex-col gap-5 p-4 h-full overflow-y-auto">
      {/* Profile card */}
      <div className="flex items-center gap-4 bg-neutral-900 border border-neutral-800 rounded-xl p-4">
        <div className="h-14 w-14 rounded-full overflow-hidden bg-white border border-neutral-700 shrink-0">
          <img src={avatarUrl} alt="Profile" className="h-full w-full object-cover" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-white font-semibold text-base truncate">
            {user?.first_name ?? '—'}
          </p>
          <p className="text-neutral-400 text-sm truncate">
            @{user?.username ?? '—'}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-white font-bold text-xl tabular-nums">
            {(user?.balance ?? 0).toLocaleString()}
          </p>
          <p className="text-neutral-500 text-xs">coins</p>
        </div>
      </div>

      {/* Games */}
      <div>
        <p className="text-neutral-500 text-xs uppercase tracking-widest font-semibold mb-3">
          Games
        </p>
        <div className="flex flex-col gap-2">
          <GameCard
            icon={Circle}
            title="Plinko"
            enabled={plinkoEnabled}
            onClick={() => onNavigate('plinko')}
          />
          <GameCard
            icon={Rocket}
            title="Rocket"
            enabled={rocketEnabled}
            onClick={() => onNavigate('rocket')}
          />
          <GameCard
            icon={RotateCw}
            title="PVP Wheel"
            enabled={pvpEnabled}
            onClick={() => onNavigate('pvp')}
          />
        </div>
      </div>

      {/* Stats */}
      <div>
        <p className="text-neutral-500 text-xs uppercase tracking-widest font-semibold mb-3">
          Stats
        </p>
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
          <div className="flex justify-between items-center">
            <span className="text-neutral-400 text-sm">Total Won</span>
            <span className="text-white font-semibold">{totalWon.toLocaleString()}</span>
          </div>
        </div>
      </div>

      {/* Dev tools */}
      <div>
        <p className="text-neutral-500 text-xs uppercase tracking-widest font-semibold mb-3">
          Dev
        </p>
        <button
          onClick={handleAddCoins}
          disabled={addingCoins}
          className="w-full bg-neutral-900 border border-neutral-800 text-white font-semibold rounded-xl px-4 py-3 hover:border-neutral-700 disabled:opacity-50"
        >
          {addingCoins ? 'Adding...' : '+ 1,000 Coins'}
        </button>
      </div>
    </div>
  )
}
