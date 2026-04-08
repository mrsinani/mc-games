# mc-games — Casino Mini App MVP1

A Telegram Mini App casino with virtual currency. No real money. Three games: Plinko, Rocket (crash), and PVP Wheel. All game outcomes are calculated server-side.

## Prerequisites

- Node.js 18+
- npm 9+
- A [Supabase](https://supabase.com) project
- A Telegram bot (see setup below)

## Setting Up the Telegram Bot

This is a manual step — you need to do this yourself via Telegram.

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow the prompts to name your bot
3. BotFather will give you a **bot token** — save it (you'll need it for the Railway environment variables)
4. Send `/setwebapp` to BotFather, select your bot, and set the Mini App URL to `https://mc-games-client.vercel.app`
5. Send `/setmenubutton` to BotFather, select your bot, and configure the chat menu button to open `https://mc-games-client.vercel.app`

## Database Setup

Run the migration and seed files against your Supabase project in order:

1. Go to your [Supabase dashboard](https://supabase.com/dashboard)
2. Select your project → **SQL Editor**
3. Run each migration file in order:
   - `supabase/migrations/001_initial_schema.sql`
   - `supabase/migrations/002_balance_functions.sql`
   - `supabase/migrations/003_sessions.sql`
   - `supabase/migrations/004_balance_game_param.sql`
   - `supabase/migrations/005_play_plinko.sql`
   - `supabase/migrations/006_plinko_config_seed.sql`
   - `supabase/migrations/007_rocket_config.sql`
   - `supabase/migrations/008_rocket_round_columns.sql`
4. Copy the contents of `supabase/seed.sql` and run it

## Configure Environment Variables

For production, environment variables are set directly on the hosting dashboards — no `.env` files needed:

- **Client (Vercel):** Project → Settings → Environment Variables
- **Server (Railway):** Project → Service → Variables

The `.env.example` files below are only needed for local development.

### Client (`client/.env`)

```
cp client/.env.example client/.env
```

Fill in:

| Variable | Value |
|---|---|
| `VITE_API_URL` | Your backend URL (default: `https://server-production-ec57.up.railway.app`) |
| `VITE_SUPABASE_URL` | From Supabase dashboard → Project Settings → API |
| `VITE_SUPABASE_ANON_KEY` | From Supabase dashboard → Project Settings → API |

### Server (`server/.env`)

```
cp server/.env.example server/.env
```

Fill in:

| Variable | Value |
|---|---|
| `PORT` | Port to run the server on (default: `3001`) |
| `BOT_TOKEN` | Telegram bot token from BotFather |
| `CLIENT_ORIGIN` | Allowed CORS origin (default: `https://mc-games-client.vercel.app`) |
| `SUPABASE_URL` | From Supabase dashboard → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | From Supabase dashboard → Project Settings → API (service_role key) |

## Start Development

Install all dependencies from the root:

```bash
npm install
```

Start both client and server simultaneously:

```bash
npm run dev
```

Or start them separately:

```bash
npm run dev:client   # Vite on http://localhost:5173
npm run dev:server   # Express on http://localhost:3001
```

### Health Check

```bash
curl https://server-production-ec57.up.railway.app/health
# {"status":"ok"}
```

## Deployment

Pushing to the `main` branch auto-deploys both services:

- **Client → Vercel** — triggers on every push; live at `https://mc-games-client.vercel.app`
- **Server → Railway** — triggers on every push; live at `https://server-production-ec57.up.railway.app`

No manual deploy steps needed after the initial setup.

## Project Structure

```
mc-games/
├── client/           # React + Vite + TypeScript + Tailwind CSS v4
│   ├── src/
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   └── index.css
│   ├── .env.example
│   └── vite.config.ts
├── server/           # Express + TypeScript + Socket.io
│   ├── src/
│   │   └── index.ts
│   └── .env.example
├── supabase/         # SQL migrations and seed data
│   ├── migrations/
│   │   ├── 001_initial_schema.sql
│   │   ├── 002_balance_functions.sql
│   │   ├── 003_sessions.sql
│   │   ├── 004_balance_game_param.sql
│   │   ├── 005_play_plinko.sql
│   │   ├── 006_plinko_config_seed.sql
│   │   ├── 007_rocket_config.sql
│   │   └── 008_rocket_round_columns.sql
│   └── seed.sql
└── prd-mvp1.md       # Product requirements document
```

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite, TypeScript |
| Styling | Tailwind CSS v4 |
| Game rendering | Phaser.js |
| Real-time | Socket.io |
| Telegram SDK | @telegram-apps/sdk-react |
| Backend | Node.js, Express, TypeScript |
| Database | Supabase (PostgreSQL) |
| Frontend hosting | Vercel |
| Backend hosting | Railway |
