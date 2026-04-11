-- Add missing columns to pvp_rooms
ALTER TABLE pvp_rooms
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS creator_id BIGINT REFERENCES users(telegram_id),
  ADD COLUMN IF NOT EXISTS min_bet INT NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS max_bet INT NOT NULL DEFAULT 10000,
  ADD COLUMN IF NOT EXISTS house_cut_pct INT NOT NULL DEFAULT 1;

-- Seed PVP config entries (idempotent)
INSERT INTO game_config (key, value) VALUES
  ('pvp_enabled', 'true'::jsonb),
  ('pvp_house_cut_pct', '1'::jsonb),
  ('pvp_max_rooms_per_user', '3'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Index for querying rooms by creator
CREATE INDEX IF NOT EXISTS idx_pvp_rooms_creator_id ON pvp_rooms(creator_id);

-- Atomic RPC: place a bet in a PVP room
-- Locks room row to prevent race conditions on ticket assignment
CREATE OR REPLACE FUNCTION pvp_place_bet(
  p_user_id BIGINT,
  p_room_id UUID,
  p_bet INT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_room pvp_rooms%ROWTYPE;
  v_user_balance INT;
  v_ticket_start INT;
  v_ticket_end INT;
  v_entry_id UUID;
  v_new_balance INT;
BEGIN
  -- Lock room row to prevent concurrent ticket assignment races
  SELECT * INTO v_room FROM pvp_rooms WHERE id = p_room_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Room not found';
  END IF;
  IF v_room.status != 'open' THEN
    RAISE EXCEPTION 'Room is not open';
  END IF;
  IF p_bet < v_room.min_bet THEN
    RAISE EXCEPTION 'Bet must be at least %', v_room.min_bet;
  END IF;
  IF p_bet > v_room.max_bet THEN
    RAISE EXCEPTION 'Bet cannot exceed %', v_room.max_bet;
  END IF;

  -- One bet per user per room
  IF EXISTS (SELECT 1 FROM pvp_entries WHERE room_id = p_room_id AND user_id = p_user_id) THEN
    RAISE EXCEPTION 'You already have a bet in this room';
  END IF;

  -- Lock and check user balance
  SELECT balance INTO v_user_balance FROM users WHERE telegram_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;
  IF v_user_balance < p_bet THEN
    RAISE EXCEPTION 'Insufficient balance';
  END IF;

  -- Debit user balance
  UPDATE users SET balance = balance - p_bet WHERE telegram_id = p_user_id;
  v_new_balance := v_user_balance - p_bet;

  -- Record transaction
  INSERT INTO transactions (user_id, amount, type, game, reference_id)
  VALUES (p_user_id, -p_bet, 'bet', 'pvp', p_room_id);

  -- Assign tickets sequentially (1 coin = 1 ticket)
  v_ticket_start := v_room.total_pot + 1;
  v_ticket_end   := v_room.total_pot + p_bet;

  -- Insert entry row
  INSERT INTO pvp_entries (room_id, user_id, bet, ticket_start, ticket_end)
  VALUES (p_room_id, p_user_id, p_bet, v_ticket_start, v_ticket_end)
  RETURNING id INTO v_entry_id;

  -- Update room pot
  UPDATE pvp_rooms SET total_pot = total_pot + p_bet WHERE id = p_room_id;

  RETURN jsonb_build_object(
    'entry_id',     v_entry_id::text,
    'ticket_start', v_ticket_start,
    'ticket_end',   v_ticket_end,
    'new_balance',  v_new_balance
  );
END;
$$;
