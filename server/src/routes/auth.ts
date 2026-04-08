import { createHmac, createHash, randomUUID } from 'crypto'
import { Router, Request, Response } from 'express'
import { authMiddleware } from '../middleware/auth'
import { supabase } from '../lib/supabase'

const router = Router()

const BOT_TOKEN = process.env['BOT_TOKEN']!
const AUTH_MAX_AGE_SECONDS = 60 * 60 * 24

router.post('/login', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { telegram_id, username, first_name } = req.user!

  const { data, error } = await supabase
    .from('users')
    .upsert(
      { telegram_id, username, first_name, last_seen_at: new Date().toISOString() },
      { onConflict: 'telegram_id' }
    )
    .select('telegram_id, username, first_name, balance')
    .single()

  if (error) {
    res.status(500).json({ error: 'Failed to upsert user' })
    return
  }

  res.json({ user: data, balance: data.balance })
})

router.post('/telegram-widget', async (req: Request, res: Response): Promise<void> => {
  const { hash, ...fields } = req.body as {
    id: number
    first_name: string
    username?: string
    photo_url?: string
    auth_date: number
    hash: string
  }

  if (!hash) {
    res.status(400).json({ error: 'Missing hash' })
    return
  }

  // Build data_check_string from all fields except hash, sorted alphabetically
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key as keyof typeof fields]}`)
    .join('\n')

  // Login Widget secret: SHA256(BOT_TOKEN) — NOT an HMAC
  const secretKey = createHash('sha256').update(BOT_TOKEN).digest()
  const expectedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex')

  if (expectedHash !== hash) {
    res.status(401).json({ error: 'Invalid hash' })
    return
  }

  // Check auth_date is not older than 24 hours
  const now = Math.floor(Date.now() / 1000)
  if (now - fields.auth_date > AUTH_MAX_AGE_SECONDS) {
    res.status(401).json({ error: 'Auth data expired' })
    return
  }

  // Upsert user
  const { data: userData, error: upsertError } = await supabase
    .from('users')
    .upsert(
      {
        telegram_id: fields.id,
        username: fields.username,
        first_name: fields.first_name,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'telegram_id' }
    )
    .select('telegram_id, username, first_name, balance')
    .single()

  if (upsertError || !userData) {
    res.status(500).json({ error: 'Failed to upsert user' })
    return
  }

  // Generate session token
  const token = randomUUID()

  const { error: sessionError } = await supabase
    .from('sessions')
    .insert({ user_id: fields.id, token })

  if (sessionError) {
    res.status(500).json({ error: 'Failed to create session' })
    return
  }

  res.json({ user: userData, balance: userData.balance, token })
})

if (process.env['NODE_ENV'] !== 'production') {
  router.post('/dev-login', async (req: Request, res: Response): Promise<void> => {
    const telegram_id = 999999999
    const username = 'dev_user'
    const first_name = 'Dev'

    const { data: userData, error: upsertError } = await supabase
      .from('users')
      .upsert(
        { telegram_id, username, first_name, last_seen_at: new Date().toISOString() },
        { onConflict: 'telegram_id' }
      )
      .select('telegram_id, username, first_name, balance')
      .single()

    if (upsertError || !userData) {
      res.status(500).json({ error: 'Failed to upsert dev user' })
      return
    }

    const token = randomUUID()
    const { error: sessionError } = await supabase
      .from('sessions')
      .insert({ user_id: telegram_id, token })

    if (sessionError) {
      res.status(500).json({ error: 'Failed to create session' })
      return
    }

    res.json({ user: userData, balance: userData.balance, token })
  })
}

export default router
