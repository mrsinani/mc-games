import { useState, useEffect, useRef, useCallback } from 'react'
import { io, type Socket } from 'socket.io-client'
import { ArrowLeft, Plus, Users, Coins, Crown, Loader2 } from 'lucide-react'
import { useApp } from '../context/AppContext'
import {
  pvpGetRooms,
  pvpGetRoom,
  pvpCreateRoom,
  pvpPlaceBet,
  pvpStartSpin,
  pvpCancelRoom,
  type PvpRoom,
  type PvpEntry,
} from '../lib/api'

const API_URL = import.meta.env.VITE_API_URL as string

const WHEEL_COLORS = [
  '#6366f1', '#f43f5e', '#10b981', '#f59e0b',
  '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6',
  '#f97316', '#84cc16', '#06b6d4', '#a855f7',
]

const SPIN_DURATION_MS = 5500

function easeOutQuint(t: number): number {
  return 1 - Math.pow(1 - t, 5)
}

function displayName(player: { username?: string | null; first_name?: string | null } | null, userId: number): string {
  return player?.username ?? player?.first_name ?? `#${userId}`
}

function avatarInitial(player: { username?: string | null; first_name?: string | null } | null): string {
  const name = player?.username ?? player?.first_name ?? '?'
  return name[0]?.toUpperCase() ?? '?'
}

interface WheelCanvasProps {
  entries: PvpEntry[]
  winnerId: number | null
  spinning: boolean
  onSpinComplete: () => void
}

function WheelCanvas({ entries, winnerId, spinning, onSpinComplete }: WheelCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rotationRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const spinStartRef = useRef<number | null>(null)
  const spinStartRotRef = useRef(0)
  const spinEndRotRef = useRef(0)
  const spinFiredRef = useRef(false)
  const avatarCacheRef = useRef<Map<number, HTMLImageElement>>(new Map())
  const sizeRef = useRef(0)
  // Stable ref so callbacks (ResizeObserver, img.onload) always use the latest drawFrame
  const drawFrameRef = useRef<() => void>(() => {})

  useEffect(() => {
    for (const entry of entries) {
      if (!entry.player?.photo_url) continue
      if (avatarCacheRef.current.has(entry.user_id)) continue
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.src = entry.player.photo_url
      img.onload = () => {
        avatarCacheRef.current.set(entry.user_id, img)
        drawFrameRef.current()
      }
    }
  }, [entries])

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current
    const size = sizeRef.current
    if (!canvas || size === 0) return
    const dpr = window.devicePixelRatio || 1
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.save()
    ctx.scale(dpr, dpr)
    drawWheel(ctx, size, entries, avatarCacheRef.current, rotationRef.current)
    ctx.restore()
  }, [entries])

  useEffect(() => { drawFrameRef.current = drawFrame }, [drawFrame])

  // Size the canvas with ResizeObserver — avoids reading clientWidth on every animation frame
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    function updateSize() {
      const size = canvas!.clientWidth
      if (size === sizeRef.current) return
      sizeRef.current = size
      canvas!.width = size * dpr
      canvas!.height = size * dpr
      drawFrameRef.current()
    }
    updateSize()
    const ro = new ResizeObserver(updateSize)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!spinning || winnerId === null) return
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)

    const totalPot = entries.reduce((s, e) => s + e.bet, 0)
    if (totalPot === 0) return

    // Find winner's angular midpoint in the wheel reference frame
    let cumulativeAngle = 0
    let winnerMidAngle = 0
    let winnerArcAngle = 0
    for (const entry of entries) {
      const arc = (entry.bet / totalPot) * 2 * Math.PI
      if (entry.user_id === winnerId) {
        winnerArcAngle = arc
        winnerMidAngle = cumulativeAngle + arc / 2
        break
      }
      cumulativeAngle += arc
    }

    // Random landing point within winner's sector (±40% of arc)
    const offset = (Math.random() - 0.5) * winnerArcAngle * 0.8
    const targetFinalRot = -winnerMidAngle - offset

    // Ensure we always spin forward at least 8 full rotations
    const endRotation = targetFinalRot + 8 * 2 * Math.PI

    spinStartRef.current = null
    spinStartRotRef.current = rotationRef.current
    spinEndRotRef.current = rotationRef.current + endRotation
    spinFiredRef.current = false

    function animate(ts: number) {
      if (spinStartRef.current === null) spinStartRef.current = ts
      const elapsed = ts - (spinStartRef.current ?? ts)
      const progress = Math.min(elapsed / SPIN_DURATION_MS, 1)
      const eased = easeOutQuint(progress)

      rotationRef.current = spinStartRotRef.current + (spinEndRotRef.current - spinStartRotRef.current) * eased
      drawFrameRef.current()

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate)
      } else {
        rafRef.current = null
        if (!spinFiredRef.current) {
          spinFiredRef.current = true
          onSpinComplete()
        }
      }
    }

    rafRef.current = requestAnimationFrame(animate)

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinning, winnerId])

  useEffect(() => {
    drawFrame()
  }, [drawFrame])

  return (
    <canvas
      ref={canvasRef}
      className="w-full aspect-square"
      style={{ touchAction: 'none' }}
    />
  )
}

function drawWheel(
  ctx: CanvasRenderingContext2D,
  size: number,
  entries: PvpEntry[],
  avatarCache: Map<number, HTMLImageElement>,
  rotation: number,
) {
  const cx = size / 2
  const cy = size / 2
  const outerR = size * 0.44
  const innerR = size * 0.12
  const avatarR = outerR * 0.64

  ctx.clearRect(0, 0, size, size)

  const totalPot = entries.reduce((s, e) => s + e.bet, 0)

  if (totalPot === 0 || entries.length === 0) {
    // Empty wheel placeholder
    ctx.beginPath()
    ctx.arc(cx, cy, outerR, 0, 2 * Math.PI)
    ctx.fillStyle = '#1c1c1c'
    ctx.fill()
    ctx.strokeStyle = '#333'
    ctx.lineWidth = 1
    ctx.stroke()
    // Center hole
    ctx.beginPath()
    ctx.arc(cx, cy, innerR, 0, 2 * Math.PI)
    ctx.fillStyle = '#0a0a0a'
    ctx.fill()
    drawPointer(ctx, size, outerR)
    return
  }

  // Draw outer glow ring
  const grd = ctx.createRadialGradient(cx, cy, outerR - 4, cx, cy, outerR + 6)
  grd.addColorStop(0, 'rgba(255,255,255,0.08)')
  grd.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.beginPath()
  ctx.arc(cx, cy, outerR + 6, 0, 2 * Math.PI)
  ctx.fillStyle = grd
  ctx.fill()

  let currentAngle = rotation - Math.PI / 2

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const fraction = entry.bet / totalPot
    const arcAngle = fraction * 2 * Math.PI
    const endAngle = currentAngle + arcAngle
    const midAngle = currentAngle + arcAngle / 2
    const color = WHEEL_COLORS[i % WHEEL_COLORS.length]

    // Segment fill with slight gradient
    const segGrd = ctx.createRadialGradient(cx, cy, innerR, cx, cy, outerR)
    segGrd.addColorStop(0, lighten(color, 0.3))
    segGrd.addColorStop(1, color)

    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.arc(cx, cy, outerR, currentAngle, endAngle)
    ctx.closePath()
    ctx.fillStyle = segGrd
    ctx.fill()

    // Divider line
    ctx.strokeStyle = '#0a0a0a'
    ctx.lineWidth = 2
    ctx.stroke()

    // Avatar / initial inside segment (only if large enough)
    if (fraction > 0.035) {
      const ax = cx + Math.cos(midAngle) * avatarR
      const ay = cy + Math.sin(midAngle) * avatarR
      const imgR = Math.max(10, Math.min(20, outerR * fraction * 0.55))

      const img = avatarCache.get(entry.user_id)
      if (img) {
        ctx.save()
        ctx.beginPath()
        ctx.arc(ax, ay, imgR, 0, 2 * Math.PI)
        ctx.clip()
        ctx.drawImage(img, ax - imgR, ay - imgR, imgR * 2, imgR * 2)
        ctx.restore()
      } else {
        // Fallback circle with initial
        ctx.beginPath()
        ctx.arc(ax, ay, imgR, 0, 2 * Math.PI)
        ctx.fillStyle = 'rgba(0,0,0,0.45)'
        ctx.fill()
        ctx.fillStyle = '#fff'
        ctx.font = `bold ${Math.round(imgR * 0.9)}px sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(
          ((entry.player?.username ?? entry.player?.first_name ?? '?')[0] ?? '?').toUpperCase(),
          ax,
          ay,
        )
      }

      // White ring around avatar
      ctx.beginPath()
      ctx.arc(ax, ay, imgR + 1, 0, 2 * Math.PI)
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    currentAngle = endAngle
  }

  // Inner hole
  ctx.beginPath()
  ctx.arc(cx, cy, innerR, 0, 2 * Math.PI)
  ctx.fillStyle = '#0a0a0a'
  ctx.fill()
  ctx.strokeStyle = '#2a2a2a'
  ctx.lineWidth = 1
  ctx.stroke()

  // Center label
  ctx.fillStyle = '#444'
  ctx.font = `bold ${Math.round(innerR * 0.55)}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('PVP', cx, cy)

  drawPointer(ctx, size, outerR)
}

function drawPointer(ctx: CanvasRenderingContext2D, size: number, outerR: number) {
  const cx = size / 2
  const tipY = size / 2 - outerR - 4
  const baseY = size / 2 - outerR + 12
  const halfW = 7

  ctx.save()
  ctx.beginPath()
  ctx.moveTo(cx, tipY)
  ctx.lineTo(cx - halfW, baseY)
  ctx.lineTo(cx + halfW, baseY)
  ctx.closePath()
  ctx.fillStyle = '#ffffff'
  ctx.shadowColor = 'rgba(255,255,255,0.7)'
  ctx.shadowBlur = 8
  ctx.fill()
  ctx.restore()
}

/** Lighten a hex color by mixing with white */
function lighten(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16)
  const r = Math.min(255, ((n >> 16) & 0xff) + Math.round(255 * amount))
  const g = Math.min(255, ((n >> 8) & 0xff) + Math.round(255 * amount))
  const b = Math.min(255, (n & 0xff) + Math.round(255 * amount))
  return `rgb(${r},${g},${b})`
}

interface CreateRoomModalProps {
  onClose: () => void
  onCreate: (title: string, minBet: number, maxBet: number) => Promise<void>
}

function CreateRoomModal({ onClose, onCreate }: CreateRoomModalProps) {
  const [title, setTitle] = useState('')
  const [minBet, setMinBet] = useState('10')
  const [maxBet, setMaxBet] = useState('10000')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const mn = parseInt(minBet, 10)
    const mx = parseInt(maxBet, 10)
    if (!title.trim()) { setError('Title is required'); return }
    if (isNaN(mn) || mn < 1) { setError('Invalid min bet'); return }
    if (isNaN(mx) || mx < mn) { setError('Max bet must be ≥ min bet'); return }
    setError(null)
    setLoading(true)
    try {
      await onCreate(title.trim(), mn, mx)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create room')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70" onClick={onClose}>
      <div
        className="w-full max-w-md bg-neutral-900 rounded-t-2xl p-6 pb-8 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-white font-bold text-lg">Create Room</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-neutral-400 text-xs mb-1 block">Room Title</label>
            <input
              className="w-full bg-neutral-800 text-white rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-1 focus:ring-indigo-500 placeholder:text-neutral-600"
              placeholder="e.g. High Stakes Only"
              maxLength={40}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-neutral-400 text-xs mb-1 block">Min Bet</label>
              <input
                type="number"
                min={1}
                className="w-full bg-neutral-800 text-white rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-1 focus:ring-indigo-500"
                value={minBet}
                onChange={(e) => setMinBet(e.target.value)}
              />
            </div>
            <div>
              <label className="text-neutral-400 text-xs mb-1 block">Max Bet</label>
              <input
                type="number"
                min={1}
                className="w-full bg-neutral-800 text-white rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-1 focus:ring-indigo-500"
                value={maxBet}
                onChange={(e) => setMaxBet(e.target.value)}
              />
            </div>
          </div>
          {error && <p className="text-rose-400 text-xs">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-50 text-white font-semibold rounded-xl py-3 transition-colors flex items-center justify-center gap-2"
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : 'Create Room'}
          </button>
        </form>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: PvpRoom['status'] }) {
  if (status === 'open') return <span className="text-xs bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full">Open</span>
  if (status === 'spinning') return <span className="text-xs bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full animate-pulse">Spinning</span>
  if (status === 'finished') return <span className="text-xs bg-neutral-700 text-neutral-400 px-2 py-0.5 rounded-full">Finished</span>
  return <span className="text-xs bg-neutral-700 text-neutral-400 px-2 py-0.5 rounded-full">Cancelled</span>
}

function Avatar({ player, size = 32, color }: { player: { username?: string | null; first_name?: string | null; photo_url?: string | null } | null; size?: number; color?: string }) {
  if (player?.photo_url) {
    return (
      <img
        src={player.photo_url}
        className="rounded-full object-cover flex-shrink-0"
        style={{ width: size, height: size }}
        alt=""
      />
    )
  }
  return (
    <div
      className="rounded-full flex items-center justify-center text-white font-bold flex-shrink-0"
      style={{ width: size, height: size, background: color ?? '#6366f1', fontSize: size * 0.4 }}
    >
      {avatarInitial(player)}
    </div>
  )
}

export function PvpGame() {
  const { user, setBalance } = useApp()
  const [view, setView] = useState<'list' | 'room'>('list')
  const [rooms, setRooms] = useState<PvpRoom[]>([])
  const [activeRoom, setActiveRoom] = useState<PvpRoom | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [loadingRooms, setLoadingRooms] = useState(false)
  const [betInput, setBetInput] = useState('')
  const [betLoading, setBetLoading] = useState(false)
  const [betError, setBetError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [spinPhase, setSpinPhase] = useState<'idle' | 'spinning' | 'result'>('idle')
  const [winnerId, setWinnerId] = useState<number | null>(null)
  const [resultData, setResultData] = useState<{ winnerName: string; winnerPhotoUrl: string | null; payout: number } | null>(null)
  const socketRef = useRef<Socket | null>(null)
  const activeRoomIdRef = useRef<string | null>(null)

  useEffect(() => {
    const socket = io(API_URL, { transports: ['websocket', 'polling'] })
    socketRef.current = socket

    socket.on('pvp:rooms_changed', () => {
      if (activeRoomIdRef.current === null) fetchRooms()
    })

    socket.on('pvp:room_update', ({ room }: { room: PvpRoom }) => {
      setActiveRoom(room)
    })

    socket.on('pvp:spinning', ({ winnerId: wid }: { winnerId: number }) => {
      setWinnerId(wid)
      setSpinPhase('spinning')
    })

    socket.on('pvp:result', ({ winnerId: wid, winnerName, winnerPhotoUrl, payout, newBalance }: {
      winnerId: number; winnerName: string; winnerPhotoUrl: string | null; payout: number; newBalance: number
    }) => {
      if (wid === user?.telegram_id) {
        setBalance(newBalance)
      }
      setResultData({ winnerName, winnerPhotoUrl, payout })
      if (activeRoomIdRef.current) {
        pvpGetRoom(activeRoomIdRef.current)
          .then(({ room }) => setActiveRoom(room))
          .catch(() => {})
      }
    })

    socket.on('pvp:cancelled', () => {
      setActiveRoom((prev) => prev ? { ...prev, status: 'cancelled' } : prev)
      setSpinPhase('idle')
    })

    return () => {
      socket.disconnect()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetchRooms = useCallback(async () => {
    setLoadingRooms(true)
    try {
      const { rooms: r } = await pvpGetRooms()
      setRooms(r)
    } catch {
      // silently ignore
    } finally {
      setLoadingRooms(false)
    }
  }, [])

  useEffect(() => {
    fetchRooms()
    // Only poll when on the list view; socket handles updates when in a room
    const interval = setInterval(() => {
      if (activeRoomIdRef.current === null) fetchRooms()
    }, 6000)
    return () => clearInterval(interval)
  }, [fetchRooms])

  async function enterRoom(roomId: string) {
    try {
      const { room } = await pvpGetRoom(roomId)
      setActiveRoom(room)
      setView('room')
      if (room.status === 'spinning') {
        setSpinPhase('spinning')
        setWinnerId(room.winner_id)
        setResultData(null)
      } else if (room.status === 'finished' && room.winner_id) {
        setSpinPhase('result')
        setWinnerId(room.winner_id)
        setResultData({ winnerName: room.winner_name ?? `User ${room.winner_id}`, winnerPhotoUrl: room.winner_photo_url, payout: room.payout ?? 0 })
      } else {
        setSpinPhase('idle')
        setWinnerId(null)
        setResultData(null)
      }
      setBetInput(String(room.min_bet))
      setBetError(null)
      setActionError(null)
      activeRoomIdRef.current = roomId
      socketRef.current?.emit('pvp:join_room', { roomId })
    } catch {
      // ignore
    }
  }

  function leaveRoom() {
    if (activeRoomIdRef.current) {
      socketRef.current?.emit('pvp:leave_room', { roomId: activeRoomIdRef.current })
      activeRoomIdRef.current = null
    }
    setActiveRoom(null)
    setView('list')
    setSpinPhase('idle')
    setWinnerId(null)
    setResultData(null)
    fetchRooms()
  }

  async function handleCreateRoom(title: string, minBet: number, maxBet: number) {
    const { room } = await pvpCreateRoom(title, minBet, maxBet)
    setShowCreate(false)
    await enterRoom(room.id)
  }

  async function handleBet() {
    if (!activeRoom) return
    const amount = parseInt(betInput, 10)
    if (isNaN(amount) || amount <= 0) { setBetError('Invalid amount'); return }
    setBetError(null)
    setBetLoading(true)
    try {
      const result = await pvpPlaceBet(activeRoom.id, amount)
      setBalance(result.new_balance)
    } catch (err) {
      setBetError(err instanceof Error ? err.message : 'Failed to place bet')
    } finally {
      setBetLoading(false)
    }
  }

  async function handleStart() {
    if (!activeRoom) return
    setActionError(null)
    setActionLoading(true)
    try {
      await pvpStartSpin(activeRoom.id)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to start')
    } finally {
      setActionLoading(false)
    }
  }

  async function handleCancel() {
    if (!activeRoom) return
    setActionError(null)
    setActionLoading(true)
    try {
      await pvpCancelRoom(activeRoom.id)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to cancel')
    } finally {
      setActionLoading(false)
    }
  }

  function handleSpinComplete() {
    setSpinPhase('result')
  }

  const myEntry = activeRoom?.pvp_entries.find((e) => e.user_id === user?.telegram_id)
  const isCreator = activeRoom?.creator_id === user?.telegram_id
  const playerCount = activeRoom?.pvp_entries.length ?? 0
  const canStart = isCreator && activeRoom?.status === 'open' && new Set(activeRoom.pvp_entries.map((e) => e.user_id)).size >= 2

  if (view === 'list') {
    return (
      <div className="h-full flex flex-col bg-black text-white overflow-hidden">
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <h1 className="text-lg font-bold">PVP Wheel</h1>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white text-sm font-semibold px-3 py-2 rounded-xl transition-colors"
          >
            <Plus className="size-4" />
            Create
          </button>
        </div>

        <div className="scrollbar-none flex-1 overflow-y-auto px-4 pb-4 space-y-3">
          {loadingRooms && rooms.length === 0 ? (
            <div className="flex items-center justify-center h-32">
              <Loader2 className="size-6 animate-spin text-neutral-500" />
            </div>
          ) : rooms.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 gap-3 text-neutral-500">
              <div className="size-12 rounded-full bg-neutral-900 flex items-center justify-center">
                <Users className="size-6" />
              </div>
              <p className="text-sm">No open rooms — create one!</p>
            </div>
          ) : (
            rooms.map((room) => (
              <button
                key={room.id}
                onClick={() => enterRoom(room.id)}
                className="w-full text-left bg-neutral-900 hover:bg-neutral-800 active:bg-neutral-700 rounded-2xl p-4 transition-colors"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Avatar player={room.creator} size={28} color="#6366f1" />
                    <div className="min-w-0">
                      <p className="font-semibold text-white text-sm truncate">{room.title}</p>
                      <p className="text-xs text-neutral-500 truncate">
                        by {displayName(room.creator, room.creator_id)}
                      </p>
                    </div>
                  </div>
                  <StatusBadge status={room.status} />
                </div>
                <div className="flex items-center gap-4 text-xs text-neutral-400">
                  <span className="flex items-center gap-1">
                    <Users className="size-3" />
                    {room.player_count ?? 0} players
                  </span>
                  <span className="flex items-center gap-1">
                    <Coins className="size-3" />
                    {room.total_pot.toLocaleString()} pot
                  </span>
                  <span className="ml-auto">
                    {room.min_bet.toLocaleString()}–{room.max_bet.toLocaleString()} coins
                  </span>
                </div>
              </button>
            ))
          )}
        </div>

        {showCreate && (
          <CreateRoomModal
            onClose={() => setShowCreate(false)}
            onCreate={handleCreateRoom}
          />
        )}
      </div>
    )
  }

  if (!activeRoom) return null

  const totalPot = activeRoom.total_pot
  const payout = Math.floor(totalPot * (1 - activeRoom.house_cut_pct / 100))
  const entries = activeRoom.pvp_entries

  return (
    <div className="h-full flex flex-col bg-black text-white overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 pt-4 pb-2 flex-shrink-0">
        <button onClick={leaveRoom} className="text-neutral-400 hover:text-white transition-colors">
          <ArrowLeft className="size-5" />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="font-bold text-white truncate">{activeRoom.title}</h1>
          <p className="text-xs text-neutral-500">
            {activeRoom.min_bet.toLocaleString()}–{activeRoom.max_bet.toLocaleString()} coins · {activeRoom.house_cut_pct}% house cut
          </p>
        </div>
        <StatusBadge status={activeRoom.status} />
      </div>

      <div className="scrollbar-none flex-1 overflow-y-auto">
        {/* Wheel */}
        <div className="flex justify-center px-6 py-2">
          <div className="w-full max-w-[300px] relative">
            <WheelCanvas
              entries={entries}
              winnerId={winnerId}
              spinning={spinPhase === 'spinning'}
              onSpinComplete={handleSpinComplete}
            />
            {/* Pot display below wheel */}
            <div className="text-center mt-2">
              <p className="text-neutral-400 text-xs">Prize pot</p>
              <p className="text-white font-bold text-xl">{payout.toLocaleString()} <span className="text-neutral-400 text-sm font-normal">coins</span></p>
            </div>
          </div>
        </div>

        {/* Winner result overlay (shown after spin completes) */}
        {spinPhase === 'result' && resultData && (
          <div className="mx-4 mb-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4 flex items-center gap-3">
            <div className="size-10 rounded-full overflow-hidden flex-shrink-0">
              {resultData.winnerPhotoUrl ? (
                <img src={resultData.winnerPhotoUrl} className="w-full h-full object-cover" alt="" />
              ) : (
                <div className="w-full h-full bg-amber-500 flex items-center justify-center text-white font-bold">
                  {resultData.winnerName[0]?.toUpperCase()}
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <Crown className="size-3.5 text-amber-400 flex-shrink-0" />
                <p className="text-amber-400 font-bold text-sm truncate">{resultData.winnerName} won!</p>
              </div>
              <p className="text-neutral-300 text-xs">{resultData.payout.toLocaleString()} coins</p>
            </div>
          </div>
        )}

        {/* Players list */}
        <div className="px-4 mb-3 space-y-2">
          <p className="text-neutral-500 text-xs uppercase tracking-wider mb-2">
            Players · {playerCount}
          </p>
          {entries.length === 0 ? (
            <p className="text-neutral-600 text-sm text-center py-4">No bets yet — be the first!</p>
          ) : (
            entries.map((entry, i) => {
              const share = totalPot > 0 ? ((entry.bet / totalPot) * 100).toFixed(1) : '0.0'
              const isMe = entry.user_id === user?.telegram_id
              const color = WHEEL_COLORS[i % WHEEL_COLORS.length]
              const isWinner = spinPhase === 'result' && winnerId === entry.user_id
              return (
                <div
                  key={entry.id}
                  className={`flex items-center gap-3 rounded-xl px-3 py-2.5 ${isWinner ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-neutral-900'}`}
                >
                  <div className="size-2.5 rounded-full flex-shrink-0" style={{ background: color }} />
                  <Avatar player={entry.player} size={28} color={color} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">
                      {displayName(entry.player, entry.user_id)}
                      {isMe && <span className="ml-1.5 text-xs text-indigo-400">(you)</span>}
                    </p>
                    <p className="text-xs text-neutral-500">{share}% of pot</p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-white font-semibold text-sm">{entry.bet.toLocaleString()}</p>
                    <p className="text-neutral-500 text-xs">coins</p>
                  </div>
                  {isWinner && <Crown className="size-4 text-amber-400 flex-shrink-0" />}
                </div>
              )
            })
          )}
        </div>

        {/* Bet section */}
        {activeRoom.status === 'open' && !myEntry && (
          <div className="px-4 mb-3">
            <div className="bg-neutral-900 rounded-2xl p-4 space-y-3">
              <p className="text-sm text-neutral-300 font-medium">Place your bet</p>
              <div className="flex gap-2">
                <input
                  type="number"
                  min={activeRoom.min_bet}
                  max={activeRoom.max_bet}
                  value={betInput}
                  onChange={(e) => setBetInput(e.target.value)}
                  className="flex-1 bg-neutral-800 text-white rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-1 focus:ring-indigo-500"
                  placeholder={`${activeRoom.min_bet}–${activeRoom.max_bet}`}
                />
                <button
                  onClick={handleBet}
                  disabled={betLoading}
                  className="bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-50 text-white font-semibold px-4 rounded-xl transition-colors flex items-center gap-1.5"
                >
                  {betLoading ? <Loader2 className="size-4 animate-spin" /> : 'Bet'}
                </button>
              </div>
              {/* Quick amounts */}
              <div className="flex gap-2">
                {[activeRoom.min_bet, Math.floor((activeRoom.min_bet + activeRoom.max_bet) / 2), activeRoom.max_bet].map((v) => (
                  <button
                    key={v}
                    onClick={() => setBetInput(String(v))}
                    className="flex-1 text-xs bg-neutral-800 hover:bg-neutral-700 text-neutral-300 py-1.5 rounded-lg transition-colors"
                  >
                    {v.toLocaleString()}
                  </button>
                ))}
              </div>
              {betError && <p className="text-rose-400 text-xs">{betError}</p>}
            </div>
          </div>
        )}

        {myEntry && activeRoom.status === 'open' && (
          <div className="px-4 mb-3">
            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-2xl px-4 py-3 text-center">
              <p className="text-emerald-400 text-sm font-medium">Bet placed: {myEntry.bet.toLocaleString()} coins</p>
              <p className="text-neutral-500 text-xs">Waiting for the room to start…</p>
            </div>
          </div>
        )}

        {/* Creator controls */}
        {isCreator && activeRoom.status === 'open' && (
          <div className="px-4 mb-4 space-y-2">
            {actionError && <p className="text-rose-400 text-xs text-center">{actionError}</p>}
            {!canStart && (
              <p className="text-neutral-500 text-xs text-center">Need at least 2 players to spin</p>
            )}
            <button
              onClick={handleStart}
              disabled={!canStart || actionLoading}
              className="w-full bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-40 text-white font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {actionLoading ? <Loader2 className="size-4 animate-spin" /> : 'Spin the Wheel'}
            </button>
            <button
              onClick={handleCancel}
              disabled={actionLoading}
              className="w-full bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 text-neutral-300 font-medium py-2.5 rounded-xl transition-colors text-sm"
            >
              Cancel Room
            </button>
          </div>
        )}

        {/* Spacer */}
        <div className="h-4" />
      </div>
    </div>
  )
}
