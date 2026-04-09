import { Router, Request, Response } from 'express'
import { authMiddleware } from '../middleware/auth'
import { supabase } from '../lib/supabase'

const router = Router()

router.get('/me', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { telegram_id } = req.user!

  const { data, error } = await supabase
    .from('users')
    .select('telegram_id, username, first_name, photo_url, balance')
    .eq('telegram_id', telegram_id)
    .single()

  if (error || !data) {
    res.status(404).json({ error: 'User not found' })
    return
  }

  res.json({ user: data })
})

router.get('/me/stats', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { telegram_id } = req.user!

  const { data: betRows, error: betError } = await supabase
    .from('transactions')
    .select('amount')
    .eq('user_id', telegram_id)
    .eq('type', 'bet')

  if (betError) {
    res.status(500).json({ error: 'Failed to fetch wager stats' })
    return
  }

  const { data: winRows, error: winError } = await supabase
    .from('transactions')
    .select('amount')
    .eq('user_id', telegram_id)
    .eq('type', 'win')

  if (winError) {
    res.status(500).json({ error: 'Failed to fetch win stats' })
    return
  }

  const totalWagered = (betRows ?? []).reduce((sum, row) => sum + Math.abs(Number(row.amount) || 0), 0)
  const totalWon = (winRows ?? []).reduce((sum, row) => sum + Math.max(0, Number(row.amount) || 0), 0)

  res.json({ totalWagered, totalWon })
})

export default router
