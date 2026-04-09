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

export default router
