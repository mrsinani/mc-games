-- Users table
CREATE TABLE users (
  telegram_id BIGINT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  balance INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW()
);

-- Transactions table
CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT REFERENCES users(telegram_id),
  amount INT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('bet', 'win', 'refund', 'manual_credit')),
  game TEXT CHECK (game IN ('plinko', 'rocket', 'pvp')),
  reference_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Game config table
CREATE TABLE game_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Plinko rounds
CREATE TABLE plinko_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT REFERENCES users(telegram_id),
  bet INT NOT NULL,
  outcome_index INT NOT NULL,
  multiplier NUMERIC NOT NULL,
  payout INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Rocket rounds
CREATE TABLE rocket_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  crash_at NUMERIC NOT NULL,
  seed TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  crashed_at TIMESTAMPTZ
);

-- Rocket entries
CREATE TABLE rocket_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID REFERENCES rocket_rounds(id),
  user_id BIGINT REFERENCES users(telegram_id),
  bet INT NOT NULL,
  cashout_at NUMERIC,
  payout INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- PVP rooms
CREATE TABLE pvp_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'spinning', 'finished', 'cancelled')),
  total_pot INT DEFAULT 0,
  winning_ticket INT,
  winner_id BIGINT REFERENCES users(telegram_id),
  house_cut INT,
  payout INT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

-- PVP entries
CREATE TABLE pvp_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID REFERENCES pvp_rooms(id),
  user_id BIGINT REFERENCES users(telegram_id),
  bet INT NOT NULL,
  ticket_start INT NOT NULL,
  ticket_end INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_transactions_user_id ON transactions(user_id);
CREATE INDEX idx_transactions_reference_id ON transactions(reference_id);
CREATE INDEX idx_rocket_entries_round_id ON rocket_entries(round_id);
CREATE INDEX idx_pvp_entries_room_id ON pvp_entries(room_id);
CREATE INDEX idx_pvp_rooms_status ON pvp_rooms(status);
