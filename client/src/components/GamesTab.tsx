import { useApp } from '../context/AppContext'
import { Circle, Rocket, RotateCw, type LucideIcon } from 'lucide-react'

interface GameCardProps {
  icon: LucideIcon
  title: string
  subtitle: string
  enabled: boolean
  onClick?: () => void
}

function GameCard({ icon: Icon, title, subtitle, enabled, onClick }: GameCardProps) {
  return (
    <div
      onClick={enabled ? onClick : undefined}
      className={`flex items-center gap-4 bg-neutral-900 border border-neutral-800 rounded-xl p-5 ${
        enabled
          ? 'cursor-pointer hover:border-neutral-700'
          : 'opacity-50 cursor-default'
      }`}
    >
      <Icon className="size-7 text-white shrink-0" strokeWidth={1.5} />
      <div className="flex-1 min-w-0">
        <p className="text-white font-semibold">{title}</p>
        <p className="text-neutral-400 text-sm">{subtitle}</p>
      </div>
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

interface GamesTabProps {
  onGameSelect: (game: string) => void
}

export function GamesTab({ onGameSelect }: GamesTabProps) {
  const { config } = useApp()

  const plinkoEnabled = Boolean(config?.plinko_enabled)
  const rocketEnabled = Boolean(config?.rocket_enabled)
  const pvpEnabled = Boolean(config?.pvp_enabled)

  return (
    <div className="flex flex-col gap-3 p-4 h-full overflow-hidden">
      <GameCard
        icon={Circle}
        title="Plinko"
        subtitle="Drop & win up to 10x"
        enabled={plinkoEnabled}
        onClick={() => onGameSelect('plinko')}
      />
      <GameCard
        icon={Rocket}
        title="Rocket"
        subtitle="Cash out before crash"
        enabled={rocketEnabled}
        onClick={() => onGameSelect('rocket')}
      />
      <GameCard
        icon={RotateCw}
        title="PVP Wheel"
        subtitle="Spin against other players"
        enabled={pvpEnabled}
      />
    </div>
  )
}
