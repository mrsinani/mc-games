-- Migration 013: Deterministic plinko
--
-- Approach: additive only. Nothing in plinko_tickets is altered.
-- A new side-table `plinko_outcomes` holds the server-computed path and
-- expected bin index for each ticket.
--
-- To fully revert: DROP TABLE plinko_outcomes CASCADE;
-- and restore start_plinko / settle_plinko from migration 012 / 011.

-- ── New side-table ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS plinko_outcomes (
  ticket_id          UUID        PRIMARY KEY REFERENCES plinko_tickets(id) ON DELETE CASCADE,
  expected_bin_index INT         NOT NULL,
  path               JSONB       NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── start_plinko ───────────────────────────────────────────────────────────
-- Now pre-computes the RTP-weighted outcome and a shuffled L/R path, writes
-- them to plinko_outcomes, and returns the path to the client.

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
  v_rtp       NUMERIC;
  v_frozen    BOOLEAN;
  v_balance   INT;
  v_ticket_id UUID;
  v_pending   INT;

  v_all_payouts   JSONB;
  v_multipliers_j JSONB;
  v_n             INT;
  v_multipliers   NUMERIC[];
  v_base_weights  NUMERIC[];
  v_total_base    NUMERIC := 0;
  v_e_base        NUMERIC := 0;
  v_min_mult      NUMERIC;
  v_max_mult      NUMERIC;
  v_prob          NUMERIC;

  v_alpha         NUMERIC := 0;
  v_alpha_lo      NUMERIC;
  v_alpha_hi      NUMERIC;
  v_log_max       NUMERIC;
  v_log_vals      NUMERIC[];
  v_lv            NUMERIC;
  v_ew            NUMERIC;
  v_sw            NUMERIC;
  v_swm           NUMERIC;
  v_e_at_alpha    NUMERIC;
  v_iter          INT;
  v_i             INT;

  v_adj_weights   NUMERIC[];
  v_total_adj     NUMERIC := 0;
  v_rand          NUMERIC;
  v_cumulative    NUMERIC;
  v_outcome_idx   INT;

  v_path          INT[];
  v_j             INT;
  v_tmp           INT;
BEGIN
  IF p_row_count < 8 OR p_row_count > 16 THEN
    RAISE EXCEPTION 'BUSINESS:Row count must be between 8 and 16';
  END IF;
  IF p_risk_level NOT IN ('LOW', 'MEDIUM', 'HIGH') THEN
    RAISE EXCEPTION 'BUSINESS:Risk level must be LOW, MEDIUM, or HIGH';
  END IF;

  SELECT
    (SELECT value::boolean FROM game_config WHERE key = 'plinko_enabled'),
    (SELECT value::int     FROM game_config WHERE key = 'min_bet'),
    (SELECT value::int     FROM game_config WHERE key = 'max_bet'),
    (SELECT value::numeric FROM game_config WHERE key = 'plinko_rtp')
  INTO v_enabled, v_min_bet, v_max_bet, v_rtp;

  IF NOT COALESCE(v_enabled, FALSE) THEN
    RAISE EXCEPTION 'BUSINESS:Plinko is currently disabled';
  END IF;
  IF p_bet < v_min_bet OR p_bet > v_max_bet THEN
    RAISE EXCEPTION 'BUSINESS:Bet must be between % and %', v_min_bet, v_max_bet;
  END IF;

  SELECT balance, is_frozen INTO v_balance, v_frozen
  FROM users WHERE telegram_id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'BUSINESS:User not found'; END IF;
  IF COALESCE(v_frozen, FALSE) THEN RAISE EXCEPTION 'BUSINESS:Account is suspended'; END IF;
  IF v_balance < p_bet THEN RAISE EXCEPTION 'BUSINESS:Insufficient balance'; END IF;

  SELECT COUNT(*) INTO v_pending
  FROM plinko_tickets
  WHERE user_id = p_user_id
    AND settled_at IS NULL
    AND created_at > NOW() - INTERVAL '60 seconds';

  IF v_pending >= 100 THEN RAISE EXCEPTION 'BUSINESS:Too many pending bets'; END IF;

  -- Payout table
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

  v_multipliers_j := v_all_payouts -> p_row_count::TEXT -> p_risk_level;
  IF v_multipliers_j IS NULL THEN
    RAISE EXCEPTION 'CONFIG:No payout data for rows=% risk=%', p_row_count, p_risk_level;
  END IF;

  v_n := jsonb_array_length(v_multipliers_j);
  v_multipliers  := array_fill(0::NUMERIC, ARRAY[v_n]);
  v_base_weights := array_fill(0::NUMERIC, ARRAY[v_n]);
  v_log_vals     := array_fill(0::NUMERIC, ARRAY[v_n]);

  FOR v_i IN 0..v_n - 1 LOOP
    v_multipliers[v_i + 1] := (v_multipliers_j ->> v_i)::NUMERIC;
    v_prob := 1;
    IF v_i > 0 THEN
      FOR v_iter IN 1..LEAST(v_i, p_row_count - v_i) LOOP
        v_prob := v_prob * (p_row_count - LEAST(v_i, p_row_count - v_i) + v_iter) / v_iter;
      END LOOP;
    END IF;
    v_base_weights[v_i + 1] := v_prob;
    v_total_base := v_total_base + v_prob;
  END LOOP;

  v_min_mult := v_multipliers[1]; v_max_mult := v_multipliers[1];
  FOR v_i IN 1..v_n LOOP
    v_e_base := v_e_base + (v_base_weights[v_i] / v_total_base) * v_multipliers[v_i];
    IF v_multipliers[v_i] < v_min_mult THEN v_min_mult := v_multipliers[v_i]; END IF;
    IF v_multipliers[v_i] > v_max_mult THEN v_max_mult := v_multipliers[v_i]; END IF;
  END LOOP;

  -- Exponential tilting to hit target RTP
  IF v_rtp IS NOT NULL AND v_rtp != v_e_base
     AND v_rtp >= v_min_mult AND v_rtp <= v_max_mult THEN
    v_alpha_lo := -20.0; v_alpha_hi := 20.0;
    FOR v_iter IN 1..60 LOOP
      v_alpha := (v_alpha_lo + v_alpha_hi) / 2.0;
      v_log_max := -1e30;
      FOR v_i IN 1..v_n LOOP
        v_lv := ln(v_base_weights[v_i]) + v_alpha * ln(v_multipliers[v_i]);
        v_log_vals[v_i] := v_lv;
        IF v_lv > v_log_max THEN v_log_max := v_lv; END IF;
      END LOOP;
      v_sw := 0; v_swm := 0;
      FOR v_i IN 1..v_n LOOP
        v_ew := exp(v_log_vals[v_i] - v_log_max);
        v_sw := v_sw + v_ew; v_swm := v_swm + v_ew * v_multipliers[v_i];
      END LOOP;
      v_e_at_alpha := v_swm / v_sw;
      EXIT WHEN abs(v_e_at_alpha - v_rtp) < 1e-9;
      IF v_e_at_alpha < v_rtp THEN v_alpha_lo := v_alpha; ELSE v_alpha_hi := v_alpha; END IF;
    END LOOP;
  END IF;

  v_log_max := -1e30;
  FOR v_i IN 1..v_n LOOP
    v_lv := ln(v_base_weights[v_i]) + v_alpha * ln(v_multipliers[v_i]);
    v_log_vals[v_i] := v_lv;
    IF v_lv > v_log_max THEN v_log_max := v_lv; END IF;
  END LOOP;
  v_adj_weights := array_fill(0::NUMERIC, ARRAY[v_n]);
  FOR v_i IN 1..v_n LOOP
    v_ew := exp(v_log_vals[v_i] - v_log_max);
    v_adj_weights[v_i] := v_ew; v_total_adj := v_total_adj + v_ew;
  END LOOP;

  -- Sample outcome
  v_rand := random() * v_total_adj; v_cumulative := 0; v_outcome_idx := v_n - 1;
  FOR v_i IN 1..v_n LOOP
    v_cumulative := v_cumulative + v_adj_weights[v_i];
    IF v_rand < v_cumulative THEN v_outcome_idx := v_i - 1; EXIT; END IF;
  END LOOP;

  -- Generate shuffled L/R path (Fisher-Yates)
  v_path := array_fill(0, ARRAY[p_row_count]);
  FOR v_i IN 1..v_outcome_idx LOOP v_path[v_i] := 1; END LOOP;
  FOR v_i IN REVERSE p_row_count..2 LOOP
    v_j := 1 + floor(random() * v_i)::INT;
    IF v_j != v_i THEN
      v_tmp := v_path[v_i]; v_path[v_i] := v_path[v_j]; v_path[v_j] := v_tmp;
    END IF;
  END LOOP;

  -- Debit bet
  UPDATE users SET balance = balance - p_bet WHERE telegram_id = p_user_id;
  INSERT INTO transactions (user_id, amount, type, game) VALUES (p_user_id, -p_bet, 'bet', 'plinko');

  -- Create ticket (unchanged table)
  INSERT INTO plinko_tickets (user_id, bet, row_count, risk_level)
  VALUES (p_user_id, p_bet, p_row_count, p_risk_level)
  RETURNING id INTO v_ticket_id;

  -- Store outcome in side-table
  INSERT INTO plinko_outcomes (ticket_id, expected_bin_index, path)
  VALUES (v_ticket_id, v_outcome_idx, to_jsonb(v_path));

  RETURN jsonb_build_object(
    'ticketId',   v_ticket_id,
    'newBalance', v_balance - p_bet,
    'path',       to_jsonb(v_path)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── settle_plinko ──────────────────────────────────────────────────────────
-- Adds outcome validation via the plinko_outcomes side-table.
-- If no outcome row exists (e.g. old tickets pre-013), falls through as before.

CREATE OR REPLACE FUNCTION settle_plinko(
  p_user_id    BIGINT,
  p_ticket_id  UUID,
  p_bin_index  INT
) RETURNS JSONB AS $$
DECLARE
  v_ticket      RECORD;
  v_outcome     RECORD;
  v_age_ms      NUMERIC;

  v_all_payouts JSONB;
  v_mults_j     JSONB;
  v_n           INT;
  v_multiplier  NUMERIC;
  v_payout      INT;
  v_new_balance INT;

  v_window_size INT     := 50;
  v_max_rtp     NUMERIC := 1.5;
  v_recent_bets NUMERIC;
  v_recent_wins NUMERIC;
BEGIN
  SELECT * INTO v_ticket FROM plinko_tickets WHERE id = p_ticket_id FOR UPDATE;
  IF NOT FOUND                        THEN RAISE EXCEPTION 'BUSINESS:Invalid ticket'; END IF;
  IF v_ticket.user_id != p_user_id   THEN RAISE EXCEPTION 'BUSINESS:Invalid ticket'; END IF;
  IF v_ticket.settled_at IS NOT NULL THEN RAISE EXCEPTION 'BUSINESS:Ticket already used'; END IF;

  v_age_ms := EXTRACT(EPOCH FROM (NOW() - v_ticket.created_at)) * 1000;
  IF v_age_ms > 60000 THEN
    UPDATE plinko_tickets SET settled_at = NOW() WHERE id = p_ticket_id;
    RAISE EXCEPTION 'BUSINESS:Ticket expired';
  END IF;
  IF v_age_ms < 1500 THEN RAISE EXCEPTION 'BUSINESS:Invalid ticket'; END IF;

  -- Validate against server-computed outcome (if present)
  SELECT * INTO v_outcome FROM plinko_outcomes WHERE ticket_id = p_ticket_id;
  IF FOUND AND p_bin_index != v_outcome.expected_bin_index THEN
    RAISE EXCEPTION 'BUSINESS:Invalid outcome';
  END IF;

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
  IF v_mults_j IS NULL THEN RAISE EXCEPTION 'CONFIG:No payout data'; END IF;

  v_n := jsonb_array_length(v_mults_j);
  IF p_bin_index < 0 OR p_bin_index >= v_n THEN RAISE EXCEPTION 'BUSINESS:Invalid bin index'; END IF;

  v_multiplier := (v_mults_j ->> p_bin_index)::NUMERIC;
  v_payout     := floor(v_ticket.bet::NUMERIC * v_multiplier)::INT;

  UPDATE plinko_tickets SET settled_at = NOW(), bin_index = p_bin_index WHERE id = p_ticket_id;

  INSERT INTO transactions (user_id, amount, type, game) VALUES (p_user_id, v_payout, 'win', 'plinko');
  UPDATE users SET balance = balance + v_payout WHERE telegram_id = p_user_id RETURNING balance INTO v_new_balance;

  INSERT INTO plinko_rounds (user_id, bet, outcome_index, multiplier, payout)
  VALUES (p_user_id, v_ticket.bet, p_bin_index, v_multiplier, v_payout);

  SELECT COALESCE(SUM(bet), 0), COALESCE(SUM(payout), 0)
  INTO v_recent_bets, v_recent_wins
  FROM (SELECT bet, payout FROM plinko_rounds WHERE user_id = p_user_id ORDER BY created_at DESC LIMIT v_window_size) r;

  IF v_recent_bets > 0 AND (v_recent_wins / v_recent_bets) > v_max_rtp THEN
    UPDATE users SET is_frozen = TRUE WHERE telegram_id = p_user_id;
  END IF;

  RETURN jsonb_build_object(
    'binIndex',   p_bin_index,
    'multiplier', v_multiplier,
    'payout',     v_payout,
    'newBalance', v_new_balance
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION start_plinko(BIGINT, INT, INT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION settle_plinko(BIGINT, UUID, INT)      TO service_role;
