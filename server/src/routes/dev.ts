import { Router, Request, Response } from 'express'
import { authMiddleware } from '../middleware/auth'
import { creditBalance } from '../lib/balance'

const router = Router()

router.post('/add-coins', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { telegram_id } = req.user!

  try {
    const { newBalance } = await creditBalance(telegram_id, 1000, 'manual_credit')
    res.json({ newBalance, message: '1,000 coins added' })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to add coins' })
  }
})

export default router
