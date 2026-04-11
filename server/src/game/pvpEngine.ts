import type { Server, Socket } from 'socket.io'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface PvpEntryRow {
  id: string
  user_id: number
  bet: number
  ticket_start: number
  ticket_end: number
}

// Track rooms that are currently settling to avoid double-settle
const spinningRooms = new Set<string>()

let ioRef: Server | null = null
let supabaseRef: SupabaseClient | null = null

export function initPvpEngine(io: Server, supabase: SupabaseClient): void {
  ioRef = io
  supabaseRef = supabase

  io.on('connection', (socket: Socket) => {
    socket.on('pvp:join_room', (data: unknown) => {
      const roomId = (data as { roomId?: string })?.roomId
      if (typeof roomId === 'string') socket.join(`pvp:${roomId}`)
    })
    socket.on('pvp:leave_room', (data: unknown) => {
      const roomId = (data as { roomId?: string })?.roomId
      if (typeof roomId === 'string') socket.leave(`pvp:${roomId}`)
    })
  })
}

export function broadcastToRoom(roomId: string, event: string, data: unknown): void {
  ioRef?.to(`pvp:${roomId}`).emit(event, data)
}

export function broadcastToAll(event: string, data: unknown): void {
  ioRef?.emit(event, data)
}

export async function startSpin(
  roomId: string,
  telegramId: number,
): Promise<{ ok: boolean; error?: string }> {
  if (!supabaseRef) return { ok: false, error: 'Engine not initialized' }
  if (spinningRooms.has(roomId)) return { ok: false, error: 'Room is already spinning' }

  const { data: room, error: roomErr } = await supabaseRef
    .from('pvp_rooms')
    .select('id, creator_id, status, total_pot, house_cut_pct, pvp_entries(id, user_id, bet, ticket_start, ticket_end)')
    .eq('id', roomId)
    .single()

  if (roomErr || !room) return { ok: false, error: 'Room not found' }
  if ((room.creator_id as number) !== telegramId) return { ok: false, error: 'Only the room creator can start the spin' }
  if (room.status !== 'open') return { ok: false, error: 'Room is not open' }

  const entries = (room.pvp_entries as PvpEntryRow[]) ?? []
  const uniqueUsers = new Set(entries.map((e) => e.user_id))
  if (uniqueUsers.size < 2) return { ok: false, error: 'Need at least 2 players to spin' }

  // Weighted-random winner via ticket lottery
  const totalTickets = room.total_pot as number
  const winningTicket = Math.floor(Math.random() * totalTickets) + 1
  const winnerEntry = entries.find((e) => e.ticket_start <= winningTicket && winningTicket <= e.ticket_end)
  if (!winnerEntry) return { ok: false, error: 'Failed to determine winner' }

  const winnerId = winnerEntry.user_id
  const houseCutPct = (room.house_cut_pct as number) ?? 1
  const houseCut = Math.floor((room.total_pot as number) * houseCutPct / 100)
  const payout = (room.total_pot as number) - houseCut

  spinningRooms.add(roomId)

  try {
    await supabaseRef
      .from('pvp_rooms')
      .update({ status: 'spinning', winning_ticket: winningTicket, winner_id: winnerId, house_cut: houseCut, payout })
      .eq('id', roomId)

    // Tell clients to start spinning — winnerId is revealed so client can animate to correct sector
    broadcastToRoom(roomId, 'pvp:spinning', { roomId, winnerId, winningTicket })

    // Settle after animation completes (~6s)
    setTimeout(() => {
      void settle(roomId, winnerId, payout)
    }, 6000)

    return { ok: true }
  } catch {
    spinningRooms.delete(roomId)
    return { ok: false, error: 'Failed to start spin' }
  }
}

async function settle(roomId: string, winnerId: number, payout: number): Promise<void> {
  if (!supabaseRef) return
  try {
    const { creditBalance } = await import('../lib/balance')
    const { newBalance } = await creditBalance(winnerId, payout, 'win', 'pvp', roomId)

    await supabaseRef
      .from('pvp_rooms')
      .update({ status: 'finished', finished_at: new Date().toISOString() })
      .eq('id', roomId)

    const { data: winner } = await supabaseRef
      .from('users')
      .select('username, first_name, photo_url')
      .eq('telegram_id', winnerId)
      .single()

    broadcastToRoom(roomId, 'pvp:result', {
      roomId,
      winnerId,
      winnerName: winner?.username ?? winner?.first_name ?? `User ${winnerId}`,
      winnerPhotoUrl: (winner?.photo_url as string | null) ?? null,
      payout,
      newBalance,
    })

    broadcastToAll('pvp:rooms_changed', {})
  } catch (err) {
    console.error('PVP settle error:', err)
  } finally {
    spinningRooms.delete(roomId)
  }
}

export async function cancelRoom(
  roomId: string,
  telegramId: number,
): Promise<{ ok: boolean; error?: string }> {
  if (!supabaseRef) return { ok: false, error: 'Engine not initialized' }

  const { data: room, error: roomErr } = await supabaseRef
    .from('pvp_rooms')
    .select('creator_id, status, pvp_entries(user_id, bet)')
    .eq('id', roomId)
    .single()

  if (roomErr || !room) return { ok: false, error: 'Room not found' }
  if ((room.creator_id as number) !== telegramId) return { ok: false, error: 'Only the room creator can cancel' }
  if (room.status !== 'open') return { ok: false, error: 'Room cannot be cancelled' }

  const { creditBalance } = await import('../lib/balance')
  for (const entry of ((room.pvp_entries as Array<{ user_id: number; bet: number }>) ?? [])) {
    await creditBalance(entry.user_id, entry.bet, 'refund', 'pvp', roomId).catch(console.error)
  }

  await supabaseRef
    .from('pvp_rooms')
    .update({ status: 'cancelled', finished_at: new Date().toISOString() })
    .eq('id', roomId)

  broadcastToRoom(roomId, 'pvp:cancelled', { roomId })
  broadcastToAll('pvp:rooms_changed', {})

  return { ok: true }
}
