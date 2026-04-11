import { Router, type Request, type Response } from 'express'

const router = Router()

interface TelegramUser {
  id: number
}

interface TelegramChat {
  id: number
}

interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  chat: TelegramChat
  text?: string
}

interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

async function callTelegram(method: string, token: string, body: object): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as { ok: boolean; description?: string }
  if (!data.ok) {
    throw new Error(`Telegram API ${method} failed: ${data.description ?? res.statusText}`)
  }
}

router.post('/telegram/webhook', async (req: Request, res: Response): Promise<void> => {
  const token = process.env['BOT_TOKEN']
  if (!token) {
    res.status(503).json({ error: 'BOT_TOKEN not configured' })
    return
  }

  const secret = process.env['TELEGRAM_WEBHOOK_SECRET']
  if (secret) {
    const header = req.get('X-Telegram-Bot-Api-Secret-Token')
    if (header !== secret) {
      res.status(401).send('Unauthorized')
      return
    }
  }

  const update = req.body as TelegramUpdate
  const text = update.message?.text?.trim()
  const chatId = update.message?.chat?.id

  if (chatId == null || text == null || !text.startsWith('/start')) {
    res.sendStatus(200)
    return
  }

  const clientOrigin = process.env['CLIENT_ORIGIN'] ?? 'https://mc-games-client.vercel.app'
  const miniAppUrl = normalizeBaseUrl(
    process.env['TELEGRAM_MINI_APP_URL'] ?? clientOrigin,
  )
  const welcome =
    process.env['TELEGRAM_START_MESSAGE'] ??
    'Welcome to MC Games — play directly in Telegram. Tap below to open the app.'
  const buttonText = process.env['TELEGRAM_START_BUTTON_TEXT'] ?? 'Play'

  try {
    await callTelegram('sendMessage', token, {
      chat_id: chatId,
      text: welcome,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: buttonText,
              web_app: { url: `${miniAppUrl}/` },
            },
          ],
        ],
      },
    })
  } catch (err) {
    console.error('telegram sendMessage:', err)
    res.status(500).send('send failed')
    return
  }

  res.sendStatus(200)
})

export default router
