import type { RowCount } from './types'

export interface BallLandEvent {
  ballId: number
  binIndex: number
}

export interface PlinkoEngineOptions {
  canvas: HTMLCanvasElement
  rowCount: RowCount
  onBallLand: (event: BallLandEvent) => void
}

const WIDTH = 760
const HEIGHT = 570
const PADDING_X = 52
const PADDING_TOP = 36
const PADDING_BOTTOM = 28
const BG = '#0f1728'

interface Vec2 { x: number; y: number }

interface AnimBall {
  id: number
  binIndex: number
  waypoints: Vec2[]
  durations: number[]
  // Per-segment visual flair (purely cosmetic, doesn't affect binIndex)
  bounceVariance: number[]  // multiplier on the upward kick height per segment
  lateralBias: number[]     // small extra x nudge on P1 per segment
  segIdx: number
  t: number
  pos: Vec2
  trail: Vec2[]
  landed: boolean
}

interface PinFlash { row: number; col: number; alpha: number }

export default class PlinkoEngine {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private rowCount: RowCount
  private onBallLand: (event: BallLandEvent) => void

  private pins: Vec2[][] = []
  private pinsLastRowXCoords: number[] = []

  private balls = new Map<number, AnimBall>()
  private nextId = 1
  private animId: number | null = null
  private lastTime = 0
  private pinFlashes: PinFlash[] = []

  constructor(options: PlinkoEngineOptions) {
    this.canvas = options.canvas
    this.ctx = this.canvas.getContext('2d')!
    this.rowCount = options.rowCount
    this.onBallLand = options.onBallLand
    this.computePins()
  }

  // ── Layout ────────────────────────────────────────────────────────────────

  private get pinDistanceX(): number {
    return (WIDTH - PADDING_X * 2) / (this.rowCount + 1)
  }

  private get pinRadius(): number {
    return (24 - this.rowCount) / 2
  }

  private get ballRadius(): number {
    return this.pinRadius * 2
  }

  private get rowSpacing(): number {
    return (HEIGHT - PADDING_TOP - PADDING_BOTTOM) / (this.rowCount - 1)
  }

  // Ball centre Y when it's resting on top of a pin (touching but not inside)
  private get contactOffset(): number {
    return this.pinRadius + this.ballRadius
  }

  // ── Public API ────────────────────────────────────────────────────────────

  start() {
    this.lastTime = performance.now()
    const tick = (now: number) => {
      const dt = Math.min((now - this.lastTime) / 1000, 0.05)
      this.lastTime = now
      this.update(dt)
      this.draw()
      this.animId = requestAnimationFrame(tick)
    }
    this.animId = requestAnimationFrame(tick)
  }

  stop() {
    if (this.animId !== null) {
      cancelAnimationFrame(this.animId)
      this.animId = null
    }
  }

  destroy() {
    this.stop()
    this.balls.clear()
  }

  dropBall(path: number[]): number {
    const id = this.nextId++
    const binIndex = path.reduce((s, v) => s + v, 0)

    // Starting jitter: cosmetic only — ball enters from a slightly random x.
    // Doesn't affect binIndex since that comes from the path, not the position.
    const startJitter = (Math.random() - 0.5) * this.pinDistanceX * 0.25

    const waypoints = this.buildWaypoints(path, startJitter)
    const durations = this.buildDurations()

    // Per-segment cosmetic variance: each bounce looks a little different
    const n = this.rowCount + 1
    const bounceVariance = Array.from({ length: n }, () => 0.7 + Math.random() * 0.6)
    const lateralBias    = Array.from({ length: n }, () => (Math.random() - 0.5) * 0.2)

    this.balls.set(id, {
      id,
      binIndex,
      waypoints,
      durations,
      bounceVariance,
      lateralBias,
      segIdx: 0,
      t: 0,
      pos: { ...waypoints[0] },
      trail: [],
      landed: false,
    })

    return id
  }

  updateRowCount(newRowCount: RowCount) {
    if (newRowCount === this.rowCount) return
    this.balls.clear()
    this.pinFlashes = []
    this.rowCount = newRowCount
    this.computePins()
  }

  get binsWidthPercentage(): number {
    if (this.pinsLastRowXCoords.length < 2) return 0.8
    const last = this.pinsLastRowXCoords
    return (last[last.length - 1] - last[0]) / WIDTH
  }

  // ── Pin layout ────────────────────────────────────────────────────────────

  private computePins() {
    this.pins = []
    this.pinsLastRowXCoords = []
    const dX = this.pinDistanceX

    for (let r = 0; r < this.rowCount; r++) {
      const rowY = PADDING_TOP + this.rowSpacing * r
      const rowPaddingX = PADDING_X + ((this.rowCount - 1 - r) * dX) / 2
      const pinsInRow = 3 + r
      const rowPins: Vec2[] = []

      for (let c = 0; c < pinsInRow; c++) {
        const x = rowPaddingX + ((WIDTH - rowPaddingX * 2) / (pinsInRow - 1)) * c
        rowPins.push({ x, y: rowY })
        if (r === this.rowCount - 1) this.pinsLastRowXCoords.push(x)
      }
      this.pins.push(rowPins)
    }
  }

  // ── Path precomputation ───────────────────────────────────────────────────

  private buildWaypoints(path: number[], startJitter = 0): Vec2[] {
    const dX = this.pinDistanceX / 2
    const co = this.contactOffset
    const wps: Vec2[] = []

    wps.push({ x: WIDTH / 2 + startJitter, y: -this.ballRadius })

    // The path pins are centred on WIDTH/2; jitter only affects the drop-in
    // segment — by pin 0 the ball is already snapped to the correct pin x.
    let x = WIDTH / 2
    for (let r = 0; r < this.rowCount; r++) {
      wps.push({ x, y: PADDING_TOP + this.rowSpacing * r - co })
      x += path[r] === 0 ? -dX : dX
    }

    wps.push({ x, y: HEIGHT + this.ballRadius })
    return wps
  }

  private buildDurations(): number[] {
    const n = this.rowCount + 1
    const dur = new Array<number>(n)

    dur[0] = 0.13 + Math.random() * 0.06  // 0.13–0.19s drop-in

    for (let r = 0; r < this.rowCount - 1; r++) {
      const progress = r / (this.rowCount - 1)
      const base = 0.26 - 0.09 * progress  // 0.26s → 0.17s gravity ramp
      dur[r + 1] = base * (0.88 + Math.random() * 0.24)  // ±12% jitter
    }

    dur[this.rowCount] = 0.18 + Math.random() * 0.06

    return dur
  }

  // ── Animation loop ────────────────────────────────────────────────────────

  private update(dt: number) {
    const toRemove: number[] = []

    for (const ball of this.balls.values()) {
      if (ball.landed) { toRemove.push(ball.id); continue }

      ball.t += dt / ball.durations[ball.segIdx]

      while (ball.t >= 1 && ball.segIdx < ball.waypoints.length - 2) {
        ball.t -= 1
        ball.segIdx++

        // Flash the pin we just landed on (wp index = row + 1)
        if (ball.segIdx >= 1 && ball.segIdx <= this.rowCount) {
          const row = ball.segIdx - 1
          const wpX = ball.waypoints[ball.segIdx].x
          const col = this.pins[row].findIndex(p => Math.abs(p.x - wpX) < 3)
          if (col >= 0) this.pinFlashes.push({ row, col, alpha: 1 })
        }
      }

      if (ball.t > 1) ball.t = 1

      ball.pos = this.interpolate(
        ball.waypoints[ball.segIdx],
        ball.waypoints[ball.segIdx + 1],
        ball.t,
        ball.segIdx,
        ball.bounceVariance[ball.segIdx],
        ball.lateralBias[ball.segIdx],
      )

      ball.trail.push({ ...ball.pos })
      if (ball.trail.length > 6) ball.trail.shift()

      if (!ball.landed && ball.pos.y >= HEIGHT) {
        ball.landed = true
        this.onBallLand({ ballId: ball.id, binIndex: ball.binIndex })
        toRemove.push(ball.id)
      }
    }

    for (const id of toRemove) this.balls.delete(id)

    this.pinFlashes = this.pinFlashes
      .map(f => ({ ...f, alpha: f.alpha - dt * 5 }))
      .filter(f => f.alpha > 0)
  }

  // ── Interpolation ─────────────────────────────────────────────────────────

  private interpolate(
    from: Vec2, to: Vec2, t: number, segIdx: number,
    bounceVar = 1, lateralBias = 0,
  ): Vec2 {
    if (segIdx === 0) {
      // Initial drop: ease-in, with a tiny lateral drift from the start jitter
      const yt = t * t
      const xt = t * t * (3 - 2 * t)  // smoothstep to snap to correct x
      return {
        x: from.x + (to.x - from.x) * xt,
        y: from.y + (to.y - from.y) * yt,
      }
    }

    const dx = to.x - from.x   // ±pinDistanceX/2
    const dy = to.y - from.y   // ≈ rowSpacing (positive = downward)
    const absDy = Math.abs(dy)

    // P1: kick sideways + varied upward pop
    const p1x = from.x + dx * (0.65 + lateralBias)
    const p1y = from.y - absDy * 0.18 * bounceVar

    // P2: drop into the next pin from slightly above
    const p2x = to.x
    const p2y = to.y - absDy * 0.14

    const mt = 1 - t
    return {
      x: mt*mt*mt*from.x + 3*mt*mt*t*p1x + 3*mt*t*t*p2x + t*t*t*to.x,
      y: mt*mt*mt*from.y + 3*mt*mt*t*p1y + 3*mt*t*t*p2y + t*t*t*to.y,
    }
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  private draw() {
    const ctx = this.ctx
    ctx.clearRect(0, 0, WIDTH, HEIGHT)
    ctx.fillStyle = BG
    ctx.fillRect(0, 0, WIDTH, HEIGHT)

    this.drawPins()
    for (const ball of this.balls.values()) this.drawBall(ball)
  }

  private drawPins() {
    const ctx = this.ctx
    const pr = this.pinRadius

    for (let r = 0; r < this.pins.length; r++) {
      for (let c = 0; c < this.pins[r].length; c++) {
        const { x, y } = this.pins[r][c]
        const flash = this.pinFlashes.find(f => f.row === r && f.col === c)

        ctx.beginPath()
        ctx.arc(x, y, pr, 0, Math.PI * 2)
        ctx.fillStyle = flash
          ? `rgba(255, 255, 255, ${0.6 + flash.alpha * 0.4})`
          : '#ffffff'
        ctx.fill()
      }
    }
  }

  private drawBall(ball: AnimBall) {
    const ctx = this.ctx
    const r = this.ballRadius

    // Subtle motion trail
    for (let i = 0; i < ball.trail.length; i++) {
      const a = (i / ball.trail.length) * 0.18
      const { x, y } = ball.trail[i]
      ctx.beginPath()
      ctx.arc(x, y, r * 0.7, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 0, 0, ${a})`
      ctx.fill()
    }

    // Ball — same red as the original Matter.js engine
    const { x, y } = ball.pos
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = '#ff0000'
    ctx.fill()
  }
}
