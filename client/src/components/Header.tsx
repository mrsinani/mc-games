import { useApp } from '../context/AppContext'

export function Header() {
  const { user } = useApp()
  const balance = user?.balance ?? 0

  return (
    <header className="shrink-0 flex items-center justify-between px-4 py-3 bg-black border-b border-neutral-800">
      <div className="h-9 w-9 rounded-full overflow-hidden bg-white border border-neutral-700">
        <img src="/mc_logo.png" alt="MC Games logo" className="h-full w-full object-cover" />
      </div>
      <span className="bg-white text-black text-sm font-semibold rounded-full px-3 py-1">
        🪙 {balance.toLocaleString()}
      </span>
    </header>
  )
}
