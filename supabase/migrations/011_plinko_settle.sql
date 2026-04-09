-- Migration 011: Plinko ticket system with anti-cheat
--
-- Flow: client calls start_plinko (debits bet, returns ticket) →
--       ball drops with pure physics →
--       client calls settle_plinko (validates ticket, credits payout)
--
-- Protections:
--   1. Single-use tickets (can't replay)
--   2. Bet params locked server-side at start time
--   3. Tickets expire after 60 seconds
--   4. Minimum time enforcement (ball can't land in <1.5s)
--   5. Statistical auto-freeze (rolling window RTP check)
--   6. Frozen users can't play

-- ── Schema changes ─────────────────────────────────────────────────────

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_frozen BOOLEAN DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS plinko_tickets (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     BIGINT      NOT NULL REFERENCES users(telegram_id),
  bet         INT         NOT NULL,
  row_count   INT         NOT NULL,
  risk_level  TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at  TIMESTAMPTZ,          -- NULL = unused
  bin_index   INT                    -- filled on settle
);

CREATE INDEX IF NOT EXISTS idx_plinko_tickets_user_pending
  ON plinko_tickets (user_id, created_at)
  WHERE settled_at IS NULL;

-- ── start_plinko ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION start_plinko(
  p_user_id    BIGINT,
  p_bet        INT,
  p_row_count  INT     DEFAULT 8,
  p_risk_level TEXT    DEFAULT 'LOW'
) RETURNS JSONB AS $$
DECLARE
  v_enabled   BOOLEAN;
  v_min_bet   INT;
  v_max_bet   INT;
  v_frozen    BOOLEAN;
  v_balance   INT;
  v_ticket_id UUID;
  v_pending   INT;
BEGIN
  -- 1. Validate params
  IF p_row_count < 8 OR p_row_count > 16 THEN
    RAISE EXCEPTION 'BUSINESS:Row count must be between 8 and 16';
  END IF;
  IF p_risk_level NOT IN ('LOW', 'MEDIUM', 'HIGH') THEN
    RAISE EXCEPTION 'BUSINESS:Risk level must be LOW, MEDIUM, or HIGH';
  END IF;

  -- 2. Load config
  SELECT
    (SELECT value::boolean FROM game_config WHERE key = 'plinko_enabled'),
    (SELECT value::int     FROM game_config WHERE key = 'min_bet'),
    (SELECT value::int     FROM game_config WHERE key = 'max_bet')
  INTO v_enabled, v_min_bet, v_max_bet;

  IF NOT COALESCE(v_enabled, FALSE) THEN
    RAISE EXCEPTION 'BUSINESS:Plinko is currently disabled';
  END IF;
  IF p_bet < v_min_bet OR p_bet > v_max_bet THEN
    RAISE EXCEPTION 'BUSINESS:Bet must be between % and %', v_min_bet, v_max_bet;
  END IF;

  -- 3. Lock user, check frozen, check balance
  SELECT balance, is_frozen INTO v_balance, v_frozen
  FROM users WHERE telegram_id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BUSINESS:User not found';
  END IF;
  IF COALESCE(v_frozen, FALSE) THEN
    RAISE EXCEPTION 'BUSINESS:Account is suspended';
  END IF;
  IF v_balance < p_bet THEN
    RAISE EXCEPTION 'BUSINESS:Insufficient balance';
  END IF;

  -- 4. Cap pending tickets (max 10 at a time to prevent flooding)
  SELECT COUNT(*) INTO v_pending
  FROM plinko_tickets
  WHERE user_id = p_user_id
    AND settled_at IS NULL
    AND created_at > NOW() - INTERVAL '60 seconds';

  IF v_pending >= 10 THEN
    RAISE EXCEPTION 'BUSINESS:Too many pending bets';
  END IF;

  -- 5. Debit bet
  UPDATE users SET balance = balance - p_bet WHERE telegram_id = p_user_id;

  INSERT INTO transactions (user_id, amount, type, game)
  VALUES (p_user_id, -p_bet, 'bet', 'plinko');

  -- 6. Create ticket
  INSERT INTO plinko_tickets (user_id, bet, row_count, risk_level)
  VALUES (p_user_id, p_bet, p_row_count, p_risk_level)
  RETURNING id INTO v_ticket_id;

  RETURN jsonb_build_object(
    'ticketId',   v_ticket_id,
    'newBalance', v_balance - p_bet
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── settle_plinko (with ticket + anti-cheat) ───────────────────────────

DROP FUNCTION IF EXISTS settle_plinko(BIGINT, INT, INT, TEXT, INT);

CREATE OR REPLACE FUNCTION settle_plinko(
  p_user_id    BIGINT,
  p_ticket_id  UUID,
  p_bin_index  INT
) RETURNS JSONB AS $$
DECLARE
  v_ticket      RECORD;
  v_age_ms      NUMERIC;

  v_all_payouts JSONB;
  v_mults_j     JSONB;
  v_n           INT;
  v_multiplier  NUMERIC;
  v_payout      INT;
  v_new_balance INT;

  -- Anti-cheat stats
  v_window_size INT := 50;
  v_max_rtp     NUMERIC := 1.5;
  v_recent_bets NUMERIC;
  v_recent_wins NUMERIC;
  v_actual_rtp  NUMERIC;
BEGIN
  -- 1. Lock and fetch ticket
  SELECT * INTO v_ticket
  FROM plinko_tickets
  WHERE id = p_ticket_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BUSINESS:Invalid ticket';
  END IF;
  IF v_ticket.user_id != p_user_id THEN
    RAISE EXCEPTION 'BUSINESS:Invalid ticket';
  END IF;
  IF v_ticket.settled_at IS NOT NULL THEN
    RAISE EXCEPTION 'BUSINESS:Ticket already used';
  END IF;

  -- 2. Check expiry (60 seconds)
  v_age_ms := EXTRACT(EPOCH FROM (NOW() - v_ticket.created_at)) * 1000;
  IF v_age_ms > 60000 THEN
    -- Mark as expired, no payout
    UPDATE plinko_tickets SET settled_at = NOW() WHERE id = p_ticket_id;
    RAISE EXCEPTION 'BUSINESS:Ticket expired';
  END IF;

  -- 3. Minimum time check (1.5 seconds — ball can't physically land faster)
  IF v_age_ms < 1500 THEN
    RAISE EXCEPTION 'BUSINESS:Invalid ticket';
  END IF;

  -- 4. Payout table
  v_all_payouts := '{
    "8":  {"LOW":[5.6,2.1,1.1,1,0.5,1,1.1,2.1,5.6],"MEDIUM":[13,3,1.3,0.7,0.4,0.7,1.3,3,13],"HIGH":[29,4,1.5,0.3,0.2,0.3,1.5,4,29]},
    "9":  {"LOW":[5.6,2,1.6,1,0.7,0.7,1,1.6,2,5.6],"MEDIUM":[18,4,1.7,0.9,0.5,0.5,0.9,1.7,4,18],"HIGH":[43,7,2,0.6,0.2,0.2,0.6,2,7,43]},
    "10": {"LOW":[8.9,3,1.4,1.1,1,0.5,1,1.1,1.4,3,8.9],"MEDIUM":[22,5,2,1.4,0.6,0.4,0.6,1.4,2,5,22],"HIGH":[76,10,3,0.9,0.3,0.2,0.3,0.9,3,10,76]},
    "11": {"LOW":[8.4,3,1.9,1.3,1,0.7,0.7,1,1.3,1.9,3,8.4],"MEDIUM":[24,6,3,1.8,0.7,0.5,0.5,0.7,1.8,3,6,24],"HIGH":[120,14,5.2,1.4,0.4,0.2,0.2,0.4,1.4,5.2,14,120]},
    "12": {"LOW":[10,3,1.6,1.4,1.1,1,0.5,1,1.1,1.4,1.6,3,10],"MEDIUM":[33,11,4,2,1.1,0.6,0.3,0.6,1.1,2,4,11,33],"HIGH":[170,24,8.1,2,0.7,0.2,0.2,0.2,0.7,2,8.1,24,170]},
    "13": {"LOW":[8.1,4,3,1.9,1.2,0.9,0.7,0.7,0.9,1.2,1.9,3,4,8.1],"MEDIUM":[43,13,6,3,1.3,0.7,0.4,0.4,0.7,1.3,3,6,13,43],"HIGH":[260,37,11,4,1,0.2,0.2,0.2,0.2,1,4,11,37,260]},
    "14": {"LOW":[7.1,4,1.9,1.4,1.3,1.1,1,0.5,1,1.1,1.3,1.4,1.9,4,7.1],"MEDIUM":[58,15,7,4,1.9,1,0.5,0.2,0.5,1,1.9,4,7,15,58],"HIGH":[420,56,18,5,1.9,0.3,0.2,0.2,0.2,0.3,1.9,5,18,56,420]},
    "15": {"LOW":[15,8,3,2,1.5,1.1,1,0.7,0.7,1,1.1,1.5,2,3,8,15],"MEDIUM":[88,18,11,5,3,1.3,0.5,0.3,0.3,0.5,1.3,3,5,11,18,88],"HIGH":[620,83,27,8,3,0.5,0.2,0.2,0.2,0.2,0.5,3,8,27,83,620]},
    "16": {"LOW":[16,9,2,1.4,1.4,1.2,1.1,1,0.5,1,1.1,1.2,1.4,1.4,2,9,16],"MEDIUM":[110,41,10,5,3,1.5,1,0.5,0.3,0.5,1,1.5,3,5,10,41,110],"HIGH":[1000,130,26,9,4,2,0.2,0.2,0.2,0.2,0.2,2,4,9,26,130,1000]}
  }'::JSONB;

  v_mults_j := v_all_payouts -> v_ticket.row_count::TEXT -> v_ticket.risk_level;
  IF v_mults_j IS NULL THEN
    RAISE EXCEPTION 'CONFIG:No payout data';
  END IF;

  v_n := jsonb_array_length(v_mults_j);
  IF p_bin_index < 0 OR p_bin_index >= v_n THEN
    RAISE EXCEPTION 'BUSINESS:Invalid bin index';
  END IF;

  -- 5. Lookup multiplier & compute payout
  v_multiplier := (v_mults_j ->> p_bin_index)::NUMERIC;
  v_payout     := floor(v_ticket.bet::NUMERIC * v_multiplier)::INT;

  -- 6. Mark ticket as settled
  UPDATE plinko_tickets
  SET settled_at = NOW(), bin_index = p_bin_index
  WHERE id = p_ticket_id;

  -- 7. Credit payout
  INSERT INTO transactions (user_id, amount, type, game)
  VALUES (p_user_id, v_payout, 'win', 'plinko');

  UPDATE users SET balance = balance + v_payout
  WHERE telegram_id = p_user_id
  RETURNING balance INTO v_new_balance;

  -- 8. Record round
  INSERT INTO plinko_rounds (user_id, bet, outcome_index, multiplier, payout)
  VALUES (p_user_id, v_ticket.bet, p_bin_index, v_multiplier, v_payout);

  -- 9. Statistical anti-cheat: check rolling window RTP
  SELECT COALESCE(SUM(bet), 0), COALESCE(SUM(payout), 0)
  INTO v_recent_bets, v_recent_wins
  FROM (
    SELECT bet, payout
    FROM plinko_rounds
    WHERE user_id = p_user_id
    ORDER BY created_at DESC
    LIMIT v_window_size
  ) recent;

  IF v_recent_bets > 0 THEN
    v_actual_rtp := v_recent_wins / v_recent_bets;
    IF v_actual_rtp > v_max_rtp THEN
      UPDATE users SET is_frozen = TRUE WHERE telegram_id = p_user_id;
    END IF;
  END IF;

  -- 10. Return
  RETURN jsonb_build_object(
    'binIndex',    p_bin_index,
    'multiplier',  v_multiplier,
    'payout',      v_payout,
    'newBalance',  v_new_balance
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── Grants ─────────────────────────────────────────────────────────────

GRANT EXECUTE ON FUNCTION start_plinko(BIGINT, INT, INT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION settle_plinko(BIGINT, UUID, INT) TO service_role;
