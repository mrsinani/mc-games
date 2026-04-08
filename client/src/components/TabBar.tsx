export type Tab = 'games' | 'profile' | 'dev'

interface TabBarProps {
  active: Tab
  onChange: (tab: Tab) => void
}

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'games', label: 'Games', icon: '🎮' },
  { id: 'profile', label: 'Profile', icon: '👤' },
  { id: 'dev', label: 'Dev', icon: '🛠' },
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
          <span className="text-xl">{tab.icon}</span>
          <span>{tab.label}</span>
        </button>
      ))}
    </nav>
  )
}
