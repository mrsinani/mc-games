import { useState } from 'react'
import { addCoins } from '../lib/api'
import { useApp } from '../context/AppContext'

export function DevTab() {
  const { setBalance } = useApp()
  const [loading, setLoading] = useState(false)

  async function handleAddCoins() {
    if (loading) return
    setLoading(true)
    try {
      const res = await addCoins()
      setBalance(res.newBalance)
    } catch {
      // silently fail — balance stays the same
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center gap-4 p-4 h-full overflow-hidden">
      <p className="text-neutral-500 text-sm">Developer Tools</p>
      <button
        onClick={handleAddCoins}
        disabled={loading}
        className="bg-white text-black font-semibold rounded-lg px-6 py-3 disabled:opacity-50"
      >
        {loading ? 'Adding…' : '+ 1,000 Coins'}
      </button>
    </div>
  )
}
