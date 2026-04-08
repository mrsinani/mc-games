import { Router, Request, Response } from 'express'
import { authMiddleware } from '../middleware/auth'
import { supabase } from '../lib/supabase'

const router = Router()

router.post('/play', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { telegram_id } = req.user!
  const { bet } = req.body

  if (typeof bet !== 'number' || !Number.isInteger(bet) || bet <= 0) {
    res.status(400).json({ error: 'Invalid bet amount' })
    return
  }

  const { data, error } = await supabase.rpc('play_plinko', {
    p_user_id: telegram_id,
    p_bet: bet,
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

  res.json(data as { outcomeIndex: number; multiplier: number; payout: number; newBalance: number })
})

export default router
