import { useEffect, useState } from 'react'
import { binColorsByRowCount } from '../../lib/plinko/colors'
import type { WinRecord } from '../../lib/plinko/types'

interface LastWinsProps {
  wins: WinRecord[]
}

const FADE_MS = 3000

interface DisplayRecord {
  win: WinRecord
  addedAt: number
}

export function LastWins({ wins }: LastWinsProps) {
  const [records, setRecords] = useState<DisplayRecord[]>([])

  // Add new wins as they arrive
  useEffect(() => {
    if (wins.length === 0) return
    const latest = wins[wins.length - 1]
    setRecords((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].win.id === latest.id) return prev
      return [...prev, { win: latest, addedAt: Date.now() }]
    })
  }, [wins])

  // Prune expired entries
  useEffect(() => {
    if (records.length === 0) return
    const timer = setInterval(() => {
      const now = Date.now()
      setRecords((prev) => prev.filter((r) => now - r.addedAt < FADE_MS))
    }, 200)
    return () => clearInterval(timer)
  }, [records.length > 0])

  return (
    <div className="flex flex-col gap-1 items-center min-h-[24px]">
      {[...records].reverse().map((rec) => {
        const age = Date.now() - rec.addedAt
        const opacity = Math.max(0, 1 - age / FADE_MS)
        const colors = binColorsByRowCount[rec.win.rowCount]
        const bg = colors.background[rec.win.binIndex] ?? 'rgb(255, 192, 0)'
        return (
          <div
            key={rec.win.id}
            className="rounded px-2 py-0.5 text-[10px] font-bold text-gray-950 text-center whitespace-nowrap transition-opacity"
            style={{ backgroundColor: bg, opacity }}
          >
            {rec.win.payout.multiplier}×
          </div>
        )
      })}
    </div>
  )
}
