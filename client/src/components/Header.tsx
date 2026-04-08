import { useApp } from '../context/AppContext'

export function Header() {
  const { user } = useApp()
  const balance = user?.balance ?? 0

  return (
    <header className="fixed top-0 left-0 right-0 z-10 flex items-center justify-between px-4 py-3 bg-black border-b border-neutral-800">
      <span className="text-white font-bold text-lg tracking-tight">Casino</span>
      <span className="bg-white text-black text-sm font-semibold rounded-full px-3 py-1">
        🪙 {balance.toLocaleString()}
      </span>
    </header>
  )
}
