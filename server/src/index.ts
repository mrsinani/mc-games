import 'dotenv/config'
import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import authRoutes from './routes/auth'
import configRoutes from './routes/config'
import userRoutes from './routes/user'
import devRoutes from './routes/dev'
import plinkoRoutes from './routes/plinko'
import rocketRoutes from './routes/rocket'
import pvpRoutes from './routes/pvp'
import telegramBotRoutes from './routes/telegramBot'
import { startRocketEngine } from './game/rocketEngine'
import { initPvpEngine } from './game/pvpEngine'
import { supabase } from './lib/supabase'

const app = express()
const httpServer = createServer(app)

const PORT = process.env['PORT'] ?? 3001
const CLIENT_ORIGIN = process.env['CLIENT_ORIGIN'] ?? 'http://localhost:5173'

const extraOrigins = (process.env['ADDITIONAL_CORS_ORIGINS'] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/** Telegram Mini App / WebView uses these; must match Socket.IO + Express or WS fails while REST works. */
const TELEGRAM_WEB_ORIGINS = ['https://web.telegram.org', 'https://telegram.org'] as const

const allowedOrigins = [
  CLIENT_ORIGIN,
  ...extraOrigins,
  ...TELEGRAM_WEB_ORIGINS,
  ...(process.env['NODE_ENV'] !== 'production'
    ? (['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'] as const)
    : []),
]

const allowedOriginsUnique = [...new Set(allowedOrigins)]

app.use(cors({ origin: allowedOriginsUnique, credentials: true }))
app.use(express.json())

export const io = new Server(httpServer, {
  cors: {
    origin: allowedOriginsUnique,
    methods: ['GET', 'POST'],
    credentials: true,
  },
})

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.use('/auth', authRoutes)
app.use('/', configRoutes)
app.use('/', userRoutes)
app.use('/dev', devRoutes)
app.use('/plinko', plinkoRoutes)
app.use('/rocket', rocketRoutes)
app.use('/pvp', pvpRoutes)
app.use('/', telegramBotRoutes)

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`)
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`)
  })
})

startRocketEngine(io, supabase)
initPvpEngine(io, supabase)

httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})

function shutdown() {
  console.log('Shutting down server…')
  httpServer.close()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
