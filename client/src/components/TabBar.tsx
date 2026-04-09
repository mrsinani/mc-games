import { Gamepad2, User, Wrench, type LucideIcon } from 'lucide-react'

export type Tab = 'games' | 'profile' | 'dev'

interface TabBarProps {
  active: Tab
  onChange: (tab: Tab) => void
}

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'games', label: 'Games', icon: Gamepad2 },
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'dev', label: 'Dev', icon: Wrench },
]

export function TabBar({ active, onChange }: TabBarProps) {
  return (
    <nav className="shrink-0 flex bg-black border-t border-neutral-800 pb-[env(safe-area-inset-bottom)]">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`flex-1 flex flex-col items-center gap-1 pt-3 pb-1 text-xs font-medium transition-colors ${
            active === tab.id ? 'text-white' : 'text-neutral-500'
          }`}
        >
          <tab.icon className="size-5" strokeWidth={1.5} />
          <span>{tab.label}</span>
        </button>
      ))}
    </nav>
  )
}
