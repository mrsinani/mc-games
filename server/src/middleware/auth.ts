import { createHmac } from 'crypto'
import { Request, Response, NextFunction } from 'express'
import { supabase } from '../lib/supabase'

declare global {
  namespace Express {
    interface Request {
      user?: {
        telegram_id: number
        username?: string
        first_name?: string
        photo_url?: string
      }
    }
  }
}

const BOT_TOKEN = process.env['BOT_TOKEN']!
// Allow 24 hours for MVP generosity
const AUTH_MAX_AGE_SECONDS = 60 * 60 * 24

function validateTelegramInitData(initData: string): Express.Request['user'] | null {
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) return null

  // Build data_check_string: all params except hash, sorted alphabetically, joined with \n
  const entries: string[] = []
  params.forEach((value, key) => {
    if (key !== 'hash') entries.push(`${key}=${value}`)
  })
  entries.sort()
  const dataCheckString = entries.join('\n')

  // Validate auth_date
  const authDate = parseInt(params.get('auth_date') ?? '0', 10)
  const now = Math.floor(Date.now() / 1000)
  if (now - authDate > AUTH_MAX_AGE_SECONDS) return null

  // Compute HMAC
  const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  const expectedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex')

  if (expectedHash !== hash) return null

  // Parse user object
  const userStr = params.get('user')
  if (!userStr) return null

  let rawUser: { id: number; username?: string; first_name?: string; photo_url?: string }
  try {
    rawUser = JSON.parse(userStr)
  } catch {
    return null
  }

  return {
    telegram_id: rawUser.id,
    username: rawUser.username,
    first_name: rawUser.first_name,
    photo_url: rawUser.photo_url,
  }
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers['authorization']

  if (!authHeader) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  if (authHeader.startsWith('tma ')) {
    const initData = authHeader.slice(4)
    const user = validateTelegramInitData(initData)

    if (!user) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    req.user = user
    next()
    return
  }

  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7)

    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('user_id, expires_at')
      .eq('token', token)
      .single()

    if (sessionError || !session) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    if (session.expires_at && new Date(session.expires_at) < new Date()) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('telegram_id, username, first_name, photo_url')
      .eq('telegram_id', session.user_id)
      .single()

    if (userError || !userData) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    req.user = {
      telegram_id: userData.telegram_id,
      username: userData.username,
      first_name: userData.first_name,
      photo_url: userData.photo_url,
    }
    next()
    return
  }

  res.status(401).json({ error: 'Unauthorized' })
}
