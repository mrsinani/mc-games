import { useEffect, useRef, useCallback } from 'react'
import { binPayouts } from '../../lib/plinko/constants'
import { binColorsByRowCount } from '../../lib/plinko/colors'
import { type RowCount, RiskLevel } from '../../lib/plinko/types'

interface BinsRowProps {
  rowCount: RowCount
  riskLevel: RiskLevel
  binsWidthPercent: number
  lastWinBinIndex: number | null
}

export function BinsRow({ rowCount, riskLevel, binsWidthPercent, lastWinBinIndex }: BinsRowProps) {
  const binRefs = useRef<(HTMLDivElement | null)[]>([])
  const animationsRef = useRef<Animation[]>([])
  const payouts = binPayouts[rowCount][riskLevel]
  const colors = binColorsByRowCount[rowCount]

  const initRef = useCallback(
    (index: number) => (el: HTMLDivElement | null) => {
      binRefs.current[index] = el
    },
    [],
  )

  useEffect(() => {
    animationsRef.current = binRefs.current.map((el) => {
      if (!el) return null!
      const anim = el.animate(
        [
          { transform: 'translateY(0)' },
          { transform: 'translateY(30%)' },
          { transform: 'translateY(0)' },
        ],
        { duration: 300, easing: 'cubic-bezier(0.18, 0.89, 0.32, 1.28)' },
      )
      anim.pause()
      return anim
    })
  }, [rowCount])

  useEffect(() => {
    if (lastWinBinIndex === null) return
    const anim = animationsRef.current[lastWinBinIndex]
    if (!anim) return
    anim.cancel()
    anim.play()
  }, [lastWinBinIndex])

  return (
    <div className="flex h-5 w-full justify-center sm:h-7">
      <div className="flex gap-[1%]" style={{ width: `${binsWidthPercent * 100}%` }}>
        {payouts.map((payout, i) => (
          <div
            key={`${rowCount}-${i}`}
            ref={initRef(i)}
            className="flex min-w-0 flex-1 items-center justify-center rounded-sm text-[7px] font-bold text-gray-950 sm:rounded-md sm:text-[11px]"
            style={{
              backgroundColor: colors.background[i],
              boxShadow: `0 2px ${colors.shadow[i]}`,
            }}
          >
            {payout}
            {payout < 100 ? '×' : ''}
          </div>
        ))}
      </div>
    </div>
  )
}
