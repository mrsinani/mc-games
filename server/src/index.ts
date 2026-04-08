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
import { startRocketEngine } from './game/rocketEngine'
import { supabase } from './lib/supabase'

const app = express()
const httpServer = createServer(app)

const PORT = process.env['PORT'] ?? 3001
const CLIENT_ORIGIN = process.env['CLIENT_ORIGIN'] ?? 'http://localhost:5173'
const allowedOrigins = [CLIENT_ORIGIN]
if (process.env['NODE_ENV'] !== 'production') {
  allowedOrigins.push('http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173')
}

app.use(cors({ origin: allowedOrigins, credentials: true }))
app.use(express.json())

export const io = new Server(httpServer, {
  cors: {
    origin: CLIENT_ORIGIN,
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

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`)
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`)
  })
})

startRocketEngine(io, supabase)

httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
