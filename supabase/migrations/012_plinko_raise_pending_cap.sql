-- Migration 012: Raise max simultaneous pending plinko tickets from 10 to 100
-- 10 was too easy to hit when spamming the drop button.

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

  -- 4. Cap pending tickets (max 100 at a time to prevent flooding)
  SELECT COUNT(*) INTO v_pending
  FROM plinko_tickets
  WHERE user_id = p_user_id
    AND settled_at IS NULL
    AND created_at > NOW() - INTERVAL '60 seconds';

  IF v_pending >= 100 THEN
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
