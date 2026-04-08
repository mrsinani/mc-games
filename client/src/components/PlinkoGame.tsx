import { useEffect, useRef, useState } from 'react'
import Phaser from 'phaser'
import { playPlinko, type PlinkoResponse } from '../lib/api'
import { useApp } from '../context/AppContext'

interface PlinkoGameProps {
  onBack: () => void
}

const BUCKET_MULTIPLIERS = ['0.2x', '0.5x', '1.5x', '3x', '10x']
// Normalized center x position for each bucket (0-1)
const BUCKET_X_NORM = [0.1, 0.3, 0.5, 0.7, 0.9]

const DROP_EVENT = 'plinko-drop'

class PlinkoScene extends Phaser.Scene {
  private ballBody: MatterJS.BodyType | null = null
  private ballGfx!: Phaser.GameObjects.Graphics
  private targetIndex = 2
  private onLanded: ((bucket: number) => void) | null = null
  private dropping = false
  private W = 0
  private H = 0
  private boardBottom = 0

  constructor() {
    super({ key: 'PlinkoScene' })
  }

  create() {
    this.W = this.scale.width
    this.H = this.scale.height
    this.boardBottom = this.H * 0.72

    this.ballGfx = this.add.graphics()
    this.buildBoard()

    this.game.events.on(
      DROP_EVENT,
      (payload: { outcomeIndex: number; onLanded: (b: number) => void }) => {
        this.targetIndex = payload.outcomeIndex
        this.onLanded = payload.onLanded
        this.startDrop()
      },
      this,
    )
  }

  private buildBoard() {
    const g = this.add.graphics()
    const ROWS = 8
    const PEG_R = 5
    const TOP = this.H * 0.10
    const ROW_SPACING = (this.boardBottom - TOP) / (ROWS - 1)

    g.fillStyle(0xffffff)

    for (let row = 0; row < ROWS; row++) {
      const y = TOP + row * ROW_SPACING
      const odd = row % 2 === 1
      const n = odd ? 6 : 5

      for (let col = 0; col < n; col++) {
        const x = (col + 1) * (this.W / (n + 1))
        g.fillCircle(x, y, PEG_R)
        this.matter.add.circle(x, y, PEG_R, {
          isStatic: true,
          restitution: 0.5,
          friction: 0,
          frictionStatic: 0,
        } as Phaser.Types.Physics.Matter.MatterBodyConfig)
      }
    }

    // Bucket borders
    const bucketW = this.W / 5
    const bucketTop = this.boardBottom + 6
    const bucketH = 36

    g.lineStyle(1, 0x444444)
    g.strokeRect(0, bucketTop, this.W, bucketH)
    for (let i = 1; i < 5; i++) {
      g.lineBetween(i * bucketW, bucketTop, i * bucketW, bucketTop + bucketH)
    }

    // Multiplier labels
    for (let i = 0; i < 5; i++) {
      this.add
        .text((i + 0.5) * bucketW, bucketTop + bucketH / 2, BUCKET_MULTIPLIERS[i], {
          color: '#ffffff',
          fontSize: '11px',
          fontFamily: 'monospace',
        })
        .setOrigin(0.5)
    }

    // Side walls to keep ball in bounds
    const wallOpts: Phaser.Types.Physics.Matter.MatterBodyConfig = { isStatic: true }
    this.matter.add.rectangle(-2, this.H / 2, 4, this.H, wallOpts)
    this.matter.add.rectangle(this.W + 2, this.H / 2, 4, this.H, wallOpts)
  }

  private startDrop() {
    if (this.dropping) return
    this.dropping = true

    if (this.ballBody) {
      this.matter.world.remove(this.ballBody)
      this.ballBody = null
    }

    const BALL_R = 7
    const startX = this.W / 2 + (Math.random() - 0.5) * 8
    const startY = 18

    this.ballBody = this.matter.add.circle(startX, startY, BALL_R, {
      restitution: 0.45,
      friction: 0.04,
      frictionAir: 0.012,
      density: 0.002,
    } as Phaser.Types.Physics.Matter.MatterBodyConfig)

    // Initial horizontal nudge toward target bucket
    const targetX = BUCKET_X_NORM[this.targetIndex] * this.W
    const dx = targetX - startX
    const vx = (dx / this.W) * 4.5
    this.matter.body.setVelocity(this.ballBody, { x: vx, y: 0 })
  }

  update() {
    this.ballGfx.clear()

    if (!this.ballBody || !this.dropping) return

    const pos = this.ballBody.position
    this.ballGfx.fillStyle(0xffffff)
    this.ballGfx.fillCircle(pos.x, pos.y, 7)

    // Continuous corrective force — ramps up as ball falls lower
    const targetX = BUCKET_X_NORM[this.targetIndex] * this.W
    const progress = Math.max(0, Math.min(1, (pos.y - 20) / (this.boardBottom - 20)))
    const factor = 0.0000025 + progress * 0.000018
    this.matter.body.applyForce(this.ballBody, pos, { x: (targetX - pos.x) * factor, y: 0 })

    // Detect landing
    if (pos.y > this.boardBottom + 4) {
      const bucket = Math.max(0, Math.min(4, Math.floor(pos.x / (this.W / 5))))
      this.dropping = false
      this.matter.world.remove(this.ballBody)
      this.ballBody = null
      this.ballGfx.clear()

      // Flash winning bucket
      const bucketW = this.W / 5
      const hl = this.add.graphics()
      hl.fillStyle(0xffffff, 0.18)
      hl.fillRect(bucket * bucketW, this.boardBottom + 6, bucketW, 36)
      this.time.delayedCall(900, () => hl.destroy())

      const cb = this.onLanded
      this.onLanded = null
      if (cb) this.time.delayedCall(350, () => cb(bucket))
    }
  }
}

export function PlinkoGame({ onBack }: PlinkoGameProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const gameRef = useRef<Phaser.Game | null>(null)
  const { setBalance, config } = useApp()

  const minBet = Math.max(1, Number(config?.['min_bet']) || 1)
  const maxBet = Math.max(minBet, Number(config?.['max_bet']) || 10000)

  const [bet, setBet] = useState(minBet)
  const [isPlaying, setIsPlaying] = useState(false)
  const [result, setResult] = useState<{ multiplier: number; payout: number } | null>(null)
  const [betError, setBetError] = useState<string | null>(null)
  const [apiError, setApiError] = useState<string | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const width = container.offsetWidth || 360
    const height = container.offsetHeight || 300

    const config: Phaser.Types.Core.GameConfig = {
      type: Phaser.AUTO,
      width,
      height,
      backgroundColor: '#000000',
      parent: container,
      physics: {
        default: 'matter',
        matter: {
          gravity: { x: 0, y: 1.8 },
          debug: false,
        },
      },
      scene: PlinkoScene,
    }

    gameRef.current = new Phaser.Game(config)

    return () => {
      gameRef.current?.destroy(true)
      gameRef.current = null
    }
  }, [])

  const handleDrop = async () => {
    if (isPlaying) return
    setApiError(null)
    setBetError(null)
    setResult(null)

    if (bet < minBet || bet > maxBet) {
      setBetError(`Bet must be between ${minBet} and ${maxBet}`)
      return
    }

    setIsPlaying(true)

    let response: PlinkoResponse
    try {
      response = await playPlinko(bet)
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Failed to place bet')
      setIsPlaying(false)
      return
    }

    const game = gameRef.current
    if (!game) {
      setIsPlaying(false)
      return
    }

    game.events.emit(DROP_EVENT, {
      outcomeIndex: response.outcomeIndex,
      onLanded: () => {
        setResult({ multiplier: response.multiplier, payout: response.payout })
        setBalance(response.newBalance)
        setIsPlaying(false)
      },
    })
  }

  return (
    <div className="h-dvh bg-black flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-neutral-800 shrink-0">
        <button
          onClick={onBack}
          className="text-white text-xl leading-none w-8 h-8 flex items-center justify-center rounded-lg hover:bg-neutral-900"
        >
          ←
        </button>
        <h1 className="text-white font-bold text-lg">Plinko</h1>
      </div>

      {/* Phaser canvas container — fills remaining space */}
      <div ref={containerRef} className="w-full flex-1 min-h-0" />

      {/* Controls */}
      <div className="shrink-0 flex flex-col gap-3 p-4 border-t border-neutral-800">
        {/* Bet input + quick bets row */}
        <div className="flex gap-2 items-end">
          <div className="flex flex-col gap-1 flex-1">
            <label className="text-neutral-400 text-xs font-medium uppercase tracking-wide">
              Bet
            </label>
            <input
              type="number"
              value={bet}
              onChange={(e) => {
                setBetError(null)
                setBet(Math.max(minBet, parseInt(e.target.value) || 0))
              }}
              disabled={isPlaying}
              className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-white text-base focus:outline-none focus:border-neutral-500 disabled:opacity-50"
              min={minBet}
              max={maxBet}
            />
          </div>
          {[10, 50, 100, 500].map((amount) => (
            <button
              key={amount}
              onClick={() => setBet(amount)}
              disabled={isPlaying}
              className="bg-neutral-900 border border-neutral-700 text-white text-xs font-medium rounded-lg px-2 py-2 hover:border-neutral-600 disabled:opacity-50"
            >
              {amount}
            </button>
          ))}
        </div>
        {betError && <p className="text-red-400 text-xs">{betError}</p>}

        {/* Drop button + result */}
        <div className="flex gap-3 items-center">
          <button
            onClick={handleDrop}
            disabled={isPlaying}
            className="flex-1 bg-white text-black font-bold rounded-lg py-3 text-base hover:bg-neutral-100 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isPlaying ? 'Dropping…' : 'Drop'}
          </button>
          {result && (
            <div className="text-center shrink-0">
              <p className="text-white font-bold text-xl">{result.multiplier}x</p>
              <p className="text-neutral-400 text-xs">
                {result.payout > 0 ? `+${result.payout}` : 'No win'}
              </p>
            </div>
          )}
        </div>

        {apiError && <p className="text-red-400 text-sm text-center">{apiError}</p>}
      </div>
    </div>
  )
}
