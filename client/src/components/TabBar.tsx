import { Home, Circle, Rocket, RotateCw, type LucideIcon } from 'lucide-react'

export type Tab = 'home' | 'plinko' | 'rocket' | 'pvp'

interface TabBarProps {
  active: Tab
  onChange: (tab: Tab) => void
  enabledGames: { plinko: boolean; rocket: boolean; pvp: boolean }
}

const TABS: { id: Tab; label: string; icon: LucideIcon; gameKey?: 'plinko' | 'rocket' | 'pvp' }[] = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'plinko', label: 'Plinko', icon: Circle, gameKey: 'plinko' },
  { id: 'rocket', label: 'Rocket', icon: Rocket, gameKey: 'rocket' },
  { id: 'pvp', label: 'PVP', icon: RotateCw, gameKey: 'pvp' },
]

export function TabBar({ active, onChange, enabledGames }: TabBarProps) {
  return (
    <nav className="shrink-0 flex bg-black border-t border-neutral-800">
      {TABS.map((tab) => {
        const disabled = tab.gameKey ? !enabledGames[tab.gameKey] : false
        return (
          <button
            key={tab.id}
            onClick={() => !disabled && onChange(tab.id)}
            className={`flex-1 flex flex-col items-center gap-1 pt-3 pb-2 text-xs font-medium transition-colors ${
              disabled
                ? 'text-neutral-700 cursor-default'
                : active === tab.id
                  ? 'text-white'
                  : 'text-neutral-500'
            }`}
          >
            <tab.icon className="size-5" strokeWidth={1.5} />
            <span>{tab.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
