# Casino Mini App — Product Requirements Document
## MVP 1

**Version:** 1.0  
**Status:** Draft  
**Platform:** Telegram Mini App

---

## 1. Overview

A Telegram Mini App casino with virtual currency only. No real money. Users authenticate automatically through Telegram, get a virtual balance, and can play three games: Plinko, Rocket, and PVP Wheel. A dev tab allows manually crediting balances during MVP. Feature flags control game availability and RTP server-side.

---

## 2. Goals

- Get all three games playable end-to-end with real backend logic
- All game outcomes calculated server-side (no client trust)
- Users authenticate via Telegram with zero friction
- Virtual balance system with full transaction history
- Feature flags for enabling/disabling games and tuning RTP without redeploying
- No real money, no withdrawals, no deposits — just a manual "add coins" button for testing

---

## 3. Out of Scope for MVP 1

- Real money, deposits, withdrawals
- Payment integrations (Stars, crypto, fiat)
- KYC / identity verification
- Mobile push notifications
- Referral system
- Admin dashboard UI (Supabase dashboard is fine for now)
- Game history UI for users
- Chat/social features

---

## 4. Users

Single user type for MVP 1. Anyone who opens the bot is automatically a player. No roles, no admin accounts in-app — admin actions happen directly in Supabase.

---

## 5. Authentication

Telegram handles auth entirely. When the Mini App opens, Telegram injects `initData` into the page. The frontend sends this with every request. The backend validates it using HMAC-SHA256 with the bot token before trusting any user ID.

No login screen. No sign-up flow. First time a verified user hits the backend, an account is created automatically with a starting balance of 0 coins.

**Users table stores:**
- Telegram user ID (primary key)
- Username
- First name
- Balance (integer, coins)
- Created at
- Last seen at

---

## 6. Virtual Balance & Transactions

All balances are integers (no decimals). Every balance change — bet, win, loss, manual credit — writes a row to the transactions table before the balance is updated. Balance is always derived from the transaction log, not stored independently as source of truth.

**Transaction types:** `bet`, `win`, `refund`, `manual_credit`

All bet + payout operations use Postgres transactions so there are no partial states. A user can never lose coins from a failed payout or win without a corresponding debit.

---

## 7. Feature Flags

Stored in a `game_config` table in Supabase. Updated live via the Supabase dashboard — no redeploy needed.

| Config Key | Type | Example Value |
|---|---|---|
| `plinko_enabled` | boolean | `true` |
| `rocket_enabled` | boolean | `true` |
| `pvp_enabled` | boolean | `false` |
| `plinko_rtp` | float | `0.95` |
| `rocket_rtp` | float | `0.93` |
| `pvp_house_cut` | float | `0.05` |
| `min_bet` | integer | `10` |
| `max_bet` | integer | `10000` |

Every game endpoint checks if the game is enabled before processing. If disabled, returns a clear error. The frontend reads a `/config` endpoint on load and hides disabled games from the UI.

---

## 8. Games

### 8.1 Plinko

Solo game. Player picks a bet amount and drops a ball. The ball bounces through pegs and lands in a bucket with a multiplier. The server decides the outcome before the animation plays — the frontend just animates the path.

**How it works:**
- Player sends `{ betAmount }` to the server
- Server validates: game enabled, user has enough balance, bet within min/max
- Server deducts bet from balance (writes `bet` transaction)
- Server picks outcome bucket using weighted RNG tuned to the configured RTP
- Server adds payout to balance (writes `win` transaction)
- Server returns `{ outcomeIndex, multiplier, payout, newBalance }` to frontend
- Frontend animates the ball falling into the correct bucket

**Buckets (configurable):**

| Bucket | Multiplier | Default Weight |
|---|---|---|
| Far left / right | 0.2x | 20% |
| Mid left / right | 0.5x | 30% |
| Center-ish | 1.5x | 30% |
| Center | 3x | 15% |
| Bullseye center | 10x | 5% |

Weights are tuned so expected value matches RTP setting. Weights are stored in game_config so they can be adjusted without code changes.

**Rows:** configurable, MVP starts with 8 rows of pegs.

---

### 8.2 Rocket (Crash Game)

Shared round game. A multiplier starts at 1x and climbs. It can crash at any moment. Players cash out before it crashes to lock in their multiplier. If they don't cash out before the crash, they lose their bet.

**Round lifecycle:**
1. Round opens — players have 5 seconds to place bets
2. Rocket launches — multiplier starts climbing in real-time
3. Players tap "Cash Out" at any point to lock their multiplier
4. Server crashes the rocket at a pre-seeded random point
5. Anyone who didn't cash out loses their bet
6. New round starts after a 3 second break

**How the crash point is determined:**
- Generated server-side before the round starts using a provably fair seed
- Crash point is never revealed until the rocket crashes
- Formula based on RTP config: higher RTP = crash points skewed higher on average

**Real-time:** Uses WebSockets (Socket.io). All connected clients in a round receive:
- `round:open` — start betting
- `round:launch` — rocket launched, multiplier ticking
- `multiplier:tick` — current multiplier (every 100ms)
- `round:crash` — crashed at X multiplier
- `cashout:confirmed` — your cashout was recorded at X multiplier

**Bet flow:**
- During betting window: `POST /rocket/bet { betAmount }`
- During flight: `POST /rocket/cashout` (or via WebSocket message)
- After crash: server settles all remaining open bets as losses

---

### 8.3 PVP Wheel

Multiplayer. Players join a room and bet any amount. Each player owns a slice of the wheel proportional to their bet. One winner takes the pot minus house cut.

**Room lifecycle:**
1. Player creates a room or joins an open one
2. Players join and bet during the open window (30 seconds or until room creator starts it manually)
3. Minimum 2 players required to spin
4. Wheel spins — winning ticket is a random integer between 1 and total_pot
5. Ticket ranges are assigned per player proportional to their bet
6. Whoever owns that ticket wins
7. Winner gets pot minus house cut

**Example:**
```
Player A bets 100 → tickets 1–100
Player B bets 50  → tickets 101–150
Total pot = 150
House cut = 5% = 7 coins
Winner pot = 143 coins
Roll: 73 → Player A wins
```

**Room states:** `open` → `spinning` → `finished`

**Real-time:** WebSocket events:
- `room:player_joined` — someone joined with their bet
- `room:spinning` — wheel is going
- `room:result` — winner ID, winning ticket, payout

**Limits:**
- Max players per room: 10
- Min bet to join: same as global min_bet config
- Room expires (refunds all) if nobody joins within 2 minutes of creation

---

## 9. Dev Tab (Manual Balance)

A tab in the app called **"Dev"** — visible to everyone in MVP 1 since there's no admin role yet.

Contains a single button: **"+ 1,000 Coins"**

Tapping it calls `POST /dev/add-coins` which credits 1,000 coins and writes a `manual_credit` transaction. No confirmation, no limit for now.

This tab gets removed or gated in MVP 2 when real deposits land.

---

## 10. Frontend Structure

The Mini App is a single-page app with a bottom tab bar.

**Tabs:**
| Tab | Contents |
|---|---|
| 🎮 Games | Game selection cards — only shows enabled games |
| 👤 Profile | Username, balance, basic stats (total wagered, biggest win) |
| 🛠 Dev | Manual coin add button |

**Game selection screen** shows cards for Plinko, Rocket, PVP. Disabled games show a "Coming Soon" badge instead of being hidden entirely, so the UI doesn't shift around when flags change.

**In-game UI** always shows current balance in the header. After every round, balance updates instantly from the server response — no polling.

---

## 11. Backend API

**Base:** REST for game actions, WebSocket for real-time (Rocket + PVP)

All requests include the Telegram `initData` in the `Authorization` header. Backend validates on every request.

| Method | Endpoint | Description |
|---|---|---|
| POST | `/auth/login` | Validate initData, create or fetch user |
| GET | `/config` | Return all game_config values |
| GET | `/me` | Current user balance and profile |
| POST | `/plinko/play` | Place plinko bet, get outcome |
| POST | `/rocket/bet` | Place bet in current open round |
| POST | `/rocket/cashout` | Cash out of current round |
| POST | `/pvp/rooms` | Create a new room |
| GET | `/pvp/rooms` | List open rooms |
| POST | `/pvp/rooms/:id/join` | Join a room with a bet |
| POST | `/pvp/rooms/:id/start` | Creator starts the spin early |
| POST | `/dev/add-coins` | Credit 1,000 coins manually |

---

## 12. Database Schema (Supabase)

```sql
users
  telegram_id   bigint PRIMARY KEY
  username      text
  first_name    text
  balance       int DEFAULT 0
  created_at    timestamptz
  last_seen_at  timestamptz

transactions
  id            uuid PRIMARY KEY
  user_id       bigint REFERENCES users
  amount        int          -- positive = credit, negative = debit
  type          text         -- bet | win | refund | manual_credit
  game          text         -- plinko | rocket | pvp | null
  reference_id  uuid         -- round/room id
  created_at    timestamptz

game_config
  key           text PRIMARY KEY
  value         jsonb
  updated_at    timestamptz

plinko_rounds
  id            uuid PRIMARY KEY
  user_id       bigint REFERENCES users
  bet           int
  outcome_index int
  multiplier    numeric
  payout        int
  created_at    timestamptz

rocket_rounds
  id            uuid PRIMARY KEY
  crash_at      numeric      -- multiplier it crashed at
  seed          text
  started_at    timestamptz
  crashed_at    timestamptz

rocket_entries
  id            uuid PRIMARY KEY
  round_id      uuid REFERENCES rocket_rounds
  user_id       bigint REFERENCES users
  bet           int
  cashout_at    numeric      -- null if they didn't cash out
  payout        int          -- 0 if lost
  created_at    timestamptz

pvp_rooms
  id            uuid PRIMARY KEY
  status        text         -- open | spinning | finished
  total_pot     int DEFAULT 0
  winning_ticket int
  winner_id     bigint REFERENCES users
  house_cut     int
  payout        int
  created_at    timestamptz
  finished_at   timestamptz

pvp_entries
  id            uuid PRIMARY KEY
  room_id       uuid REFERENCES pvp_rooms
  user_id       bigint REFERENCES users
  bet           int
  ticket_start  int
  ticket_end    int
  created_at    timestamptz
```

---

## 13. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | React + Vite | Single page, Telegram Web App SDK |
| Game rendering | Phaser.js | Plinko physics; Rocket/PVP use CSS/Canvas |
| Real-time | Socket.io | Rocket rounds + PVP rooms |
| Backend | Node.js + Express | REST + Socket.io server |
| Database | Supabase (Postgres) | Auth, balances, game data |
| Hosting (frontend) | Vercel | Free tier, auto HTTPS |
| Hosting (backend) | Railway | Free tier, supports WebSockets |
| Local tunnel | ngrok | Dev testing inside Telegram |

---

## 14. Non-Functional Requirements

- All game outcomes must be calculated server-side. The frontend never decides who wins.
- Balance updates must be atomic. No partial states.
- Telegram `initData` must be validated on every single backend request.
- The `/config` endpoint is the only unauthenticated endpoint (game list needs to load before auth in some flows).
- Minimum bet and maximum bet enforced server-side, not just client-side.
- PVP rooms that don't fill within 2 minutes auto-cancel and refund all entries.

---

## 15. Build Order

1. **Supabase** — create all tables, seed game_config defaults
2. **Backend foundation** — Express server, Telegram initData validation, `/auth/login`, `/me`, `/config`
3. **Balance system** — transaction logging, atomic bet/payout helpers
4. **Dev tab endpoint** — `/dev/add-coins`
5. **Plinko** — game logic, RTP weighting, endpoint
6. **Frontend shell** — Telegram SDK wired up, tab bar, balance display, Dev tab
7. **Plinko UI** — Phaser.js physics animation connected to backend
8. **Rocket backend** — round management, WebSocket events, crash seeding
9. **Rocket UI** — multiplier animation, cash out button
10. **PVP backend** — room management, proportional tickets, WebSocket events
11. **PVP UI** — room browser, wheel spin animation
12. **QA** — test all feature flags, test edge cases (double bet, disconnect mid-round, room timeout)
