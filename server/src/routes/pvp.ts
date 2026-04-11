import { Router, Request, Response } from 'express'
import { authMiddleware } from '../middleware/auth'
import { supabase } from '../lib/supabase'
import { startSpin, cancelRoom, broadcastToRoom, broadcastToAll } from '../game/pvpEngine'

const router = Router()

type UserInfo = { username: string | null; first_name: string | null; photo_url: string | null }

async function fetchUserMap(userIds: number[]): Promise<Record<number, UserInfo>> {
  const unique = [...new Set(userIds)].filter(Boolean)
  if (unique.length === 0) return {}
  const { data } = await supabase
    .from('users')
    .select('telegram_id, username, first_name, photo_url')
    .in('telegram_id', unique)
  const map: Record<number, UserInfo> = {}
  for (const u of data ?? []) {
    map[u.telegram_id as number] = {
      username: u.username as string | null,
      first_name: u.first_name as string | null,
      photo_url: u.photo_url as string | null,
    }
  }
  return map
}

// POST /pvp/rooms — create a new room
router.post('/rooms', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { telegram_id } = req.user!
  const { title, minBet, maxBet } = req.body as { title: unknown; minBet: unknown; maxBet: unknown }

  if (typeof title !== 'string' || title.trim().length === 0) {
    res.status(400).json({ error: 'Title is required' })
    return
  }
  if (title.trim().length > 40) {
    res.status(400).json({ error: 'Title must be 40 characters or less' })
    return
  }
  if (typeof minBet !== 'number' || !Number.isInteger(minBet) || minBet < 1) {
    res.status(400).json({ error: 'Invalid min bet — must be a positive integer' })
    return
  }
  if (typeof maxBet !== 'number' || !Number.isInteger(maxBet) || maxBet < minBet) {
    res.status(400).json({ error: 'Max bet must be >= min bet' })
    return
  }

  // Fetch config + open room count in parallel
  const [{ data: maxRoomsRow }, { data: houseCutRow }, { count }] = await Promise.all([
    supabase.from('game_config').select('value').eq('key', 'pvp_max_rooms_per_user').single(),
    supabase.from('game_config').select('value').eq('key', 'pvp_house_cut_pct').single(),
    supabase.from('pvp_rooms').select('id', { count: 'exact', head: true }).eq('creator_id', telegram_id).eq('status', 'open'),
  ])

  const maxRooms = typeof maxRoomsRow?.value === 'number' ? (maxRoomsRow.value as number) : 3
  const houseCutPct = typeof houseCutRow?.value === 'number' ? (houseCutRow.value as number) : 1

  if ((count ?? 0) >= maxRooms) {
    res.status(400).json({ error: `You can have at most ${maxRooms} open rooms at a time` })
    return
  }

  const { data: room, error: insertErr } = await supabase
    .from('pvp_rooms')
    .insert({
      title: title.trim(),
      creator_id: telegram_id,
      min_bet: minBet,
      max_bet: maxBet,
      house_cut_pct: houseCutPct,
      status: 'open',
      total_pot: 0,
    })
    .select('id, title, creator_id, status, min_bet, max_bet, house_cut_pct, total_pot, created_at')
    .single()

  if (insertErr || !room) {
    res.status(500).json({ error: 'Failed to create room' })
    return
  }

  broadcastToAll('pvp:rooms_changed', {})
  res.json({ room })
})

// GET /pvp/rooms — list open/spinning rooms
router.get('/rooms', authMiddleware, async (_req: Request, res: Response): Promise<void> => {
  const { data: rooms, error } = await supabase
    .from('pvp_rooms')
    .select('id, title, creator_id, status, min_bet, max_bet, house_cut_pct, total_pot, created_at, pvp_entries(user_id)')
    .in('status', ['open', 'spinning'])
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) {
    res.status(500).json({ error: 'Failed to fetch rooms' })
    return
  }

  const roomList = rooms ?? []
  const creatorIds = roomList.map((r) => r.creator_id as number)
  const creatorMap = await fetchUserMap(creatorIds)

  const enriched = roomList.map((r) => ({
    ...r,
    creator: creatorMap[r.creator_id as number] ?? null,
    player_count: ((r.pvp_entries as unknown[]) ?? []).length,
    pvp_entries: undefined,
  }))

  res.json({ rooms: enriched })
})

// GET /pvp/rooms/:id — full room details with entries + user info
router.get('/rooms/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params

  const [{ data: room, error }, { data: entries }] = await Promise.all([
    supabase
      .from('pvp_rooms')
      .select('id, title, creator_id, status, min_bet, max_bet, house_cut_pct, total_pot, winning_ticket, winner_id, payout, created_at, finished_at')
      .eq('id', id)
      .single(),
    supabase
      .from('pvp_entries')
      .select('id, user_id, bet, ticket_start, ticket_end')
      .eq('room_id', id)
      .order('created_at', { ascending: true }),
  ])

  if (error || !room) {
    res.status(404).json({ error: 'Room not found' })
    return
  }

  const entryList = entries ?? []
  const userMap = await fetchUserMap([
    room.creator_id as number,
    ...entryList.map((e) => e.user_id as number),
    ...(room.winner_id ? [room.winner_id as number] : []),
  ])

  const winnerUser = room.winner_id ? userMap[room.winner_id as number] : null

  res.json({
    room: {
      ...room,
      creator: userMap[room.creator_id as number] ?? null,
      pvp_entries: entryList.map((e) => ({ ...e, player: userMap[e.user_id as number] ?? null })),
      winner_name: winnerUser?.username ?? winnerUser?.first_name ?? null,
      winner_photo_url: winnerUser?.photo_url ?? null,
    },
  })
})

// POST /pvp/rooms/:id/bet — place a bet (atomic via RPC)
router.post('/rooms/:id/bet', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { telegram_id } = req.user!
  const { id: roomId } = req.params
  const { bet } = req.body as { bet: unknown }

  if (typeof bet !== 'number' || !Number.isInteger(bet) || bet <= 0) {
    res.status(400).json({ error: 'Invalid bet amount — must be a positive integer' })
    return
  }

  const { data, error } = await supabase.rpc('pvp_place_bet', {
    p_user_id: telegram_id,
    p_room_id: roomId,
    p_bet: bet,
  })

  if (error) {
    res.status(400).json({ error: error.message })
    return
  }

  // Broadcast updated room snapshot to viewers in this room
  const [{ data: updatedRoom }, { data: entries }] = await Promise.all([
    supabase
      .from('pvp_rooms')
      .select('id, title, creator_id, status, min_bet, max_bet, house_cut_pct, total_pot')
      .eq('id', roomId)
      .single(),
    supabase
      .from('pvp_entries')
      .select('id, user_id, bet, ticket_start, ticket_end')
      .eq('room_id', roomId)
      .order('created_at', { ascending: true }),
  ])

  const entryList = entries ?? []
  const userMap = await fetchUserMap(entryList.map((e) => e.user_id as number))

  if (updatedRoom) {
    broadcastToRoom(String(roomId), 'pvp:room_update', {
      room: {
        ...updatedRoom,
        pvp_entries: entryList.map((e) => ({ ...e, player: userMap[e.user_id as number] ?? null })),
      },
    })
  }

  broadcastToAll('pvp:rooms_changed', {})
  res.json({ success: true, ...(data as object) })
})

// POST /pvp/rooms/:id/start — creator starts the spin
router.post('/rooms/:id/start', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const result = await startSpin(String(req.params.id), req.user!.telegram_id)
  if (!result.ok) {
    res.status(400).json({ error: result.error })
    return
  }
  res.json({ success: true })
})

// POST /pvp/rooms/:id/cancel — creator cancels the room
router.post('/rooms/:id/cancel', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const result = await cancelRoom(String(req.params.id), req.user!.telegram_id)
  if (!result.ok) {
    res.status(400).json({ error: result.error })
    return
  }
  res.json({ success: true })
})

export default router
