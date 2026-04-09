import { useApp } from '../context/AppContext'

export function ProfileTab() {
  const { user } = useApp()
  const avatarUrl = user?.photo_url || '/mc_logo.png'

  return (
    <div className="flex flex-col gap-6 p-4 h-full overflow-hidden">
      <div className="flex justify-center">
        <div className="h-20 w-20 rounded-full overflow-hidden bg-white border border-neutral-700">
          <img src={avatarUrl} alt="Profile picture" className="h-full w-full object-cover" />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-neutral-400 text-sm">Username</p>
        <p className="text-white font-semibold text-lg">
          @{user?.username ?? '—'}
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-neutral-400 text-sm">Name</p>
        <p className="text-white font-semibold text-lg">
          {user?.first_name ?? '—'}
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-neutral-400 text-sm">Balance</p>
        <p className="text-white font-bold text-4xl">
          🪙 {(user?.balance ?? 0).toLocaleString()}
        </p>
      </div>

      <div className="border-t border-neutral-800 pt-6 flex flex-col gap-4">
        <p className="text-neutral-500 text-xs uppercase tracking-widest font-semibold">
          Stats
        </p>
        <div className="flex flex-col gap-3">
          <div className="flex justify-between items-center">
            <span className="text-neutral-400">Total Wagered</span>
            <span className="text-white font-semibold">🪙 0</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-neutral-400">Biggest Win</span>
            <span className="text-white font-semibold">🪙 0</span>
          </div>
        </div>
      </div>
    </div>
  )
}
