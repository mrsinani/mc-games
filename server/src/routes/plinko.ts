import { Router, Request, Response } from 'express'
import { authMiddleware } from '../middleware/auth'
import { supabase } from '../lib/supabase'

const router = Router()

const VALID_RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const

// Start a plinko round — debits the bet and returns a ticket
router.post('/start', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { telegram_id } = req.user!
  const { bet, rowCount, riskLevel } = req.body

  if (typeof bet !== 'number' || !Number.isInteger(bet) || bet <= 0) {
    res.status(400).json({ error: 'Invalid bet amount' })
    return
  }

  const rc = rowCount ?? 8
  if (typeof rc !== 'number' || !Number.isInteger(rc) || rc < 8 || rc > 16) {
    res.status(400).json({ error: 'Row count must be an integer between 8 and 16' })
    return
  }

  const rl = riskLevel ?? 'LOW'
  if (!VALID_RISK_LEVELS.includes(rl)) {
    res.status(400).json({ error: 'Risk level must be LOW, MEDIUM, or HIGH' })
    return
  }

  const { data, error } = await supabase.rpc('start_plinko', {
    p_user_id: telegram_id,
    p_bet: bet,
    p_row_count: rc,
    p_risk_level: rl,
  })

  if (error) {
    const msg: string = error.message ?? ''
    if (msg.startsWith('BUSINESS:')) {
      res.status(400).json({ error: msg.slice('BUSINESS:'.length) })
    } else {
      res.status(500).json({ error: 'Internal server error' })
    }
    return
  }

  res.json(data as { ticketId: string; newBalance: number })
})

// Settle a plinko round — validates ticket, credits payout
router.post('/settle', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { telegram_id } = req.user!
  const { ticketId, binIndex } = req.body

  if (typeof ticketId !== 'string' || !ticketId) {
    res.status(400).json({ error: 'Missing ticket ID' })
    return
  }

  if (typeof binIndex !== 'number' || !Number.isInteger(binIndex) || binIndex < 0 || binIndex > 16) {
    res.status(400).json({ error: 'Invalid bin index' })
    return
  }

  const { data, error } = await supabase.rpc('settle_plinko', {
    p_user_id: telegram_id,
    p_ticket_id: ticketId,
    p_bin_index: binIndex,
  })

  if (error) {
    const msg: string = error.message ?? ''
    if (msg.startsWith('BUSINESS:')) {
      res.status(400).json({ error: msg.slice('BUSINESS:'.length) })
    } else {
      res.status(500).json({ error: 'Internal server error' })
    }
    return
  }

  res.json(data as { binIndex: number; multiplier: number; payout: number; newBalance: number })
})

export default router
