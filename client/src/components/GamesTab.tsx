import { useApp } from '../context/AppContext'

interface GameCardProps {
  icon: string
  title: string
  subtitle: string
  enabled: boolean
}

function GameCard({ icon, title, subtitle, enabled }: GameCardProps) {
  return (
    <div
      className={`flex items-center gap-4 bg-neutral-900 border border-neutral-800 rounded-xl p-5 ${
        enabled
          ? 'cursor-pointer hover:border-neutral-700'
          : 'opacity-50 cursor-default'
      }`}
    >
      <span className="text-3xl">{icon}</span>
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

export function GamesTab() {
  const { config } = useApp()

  const plinkoEnabled = Boolean(config?.plinko_enabled)
  const rocketEnabled = Boolean(config?.rocket_enabled)
  const pvpEnabled = Boolean(config?.pvp_enabled)

  return (
    <div className="flex flex-col gap-3 p-4">
      <GameCard
        icon="🔮"
        title="Plinko"
        subtitle="Drop & win up to 10x"
        enabled={plinkoEnabled}
      />
      <GameCard
        icon="🚀"
        title="Rocket"
        subtitle="Cash out before crash"
        enabled={rocketEnabled}
      />
      <GameCard
        icon="🎡"
        title="PVP Wheel"
        subtitle="Spin against other players"
        enabled={pvpEnabled}
      />
    </div>
  )
}
