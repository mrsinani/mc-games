import { Router, Request, Response } from 'express'
import { supabase } from '../lib/supabase'

const router = Router()

router.get('/config', async (_req: Request, res: Response): Promise<void> => {
  const { data, error } = await supabase.from('game_config').select('key, value')

  if (error) {
    res.status(500).json({ error: 'Failed to fetch config' })
    return
  }

  const config: Record<string, unknown> = {}
  for (const row of data ?? []) {
    config[row.key] = row.value
  }

  res.json(config)
})

export default router
