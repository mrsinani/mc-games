-- Migration 010: play_plinko v3 — returns a L/R path array
--
-- Instead of just returning outcomeIndex, the server now also returns
-- a `path` array of 0s and 1s (0=left, 1=right) that the client uses
-- to deterministically animate the ball through the pin grid.
--
-- The path is a shuffled sequence with exactly `outcomeIndex` rights
-- and `rowCount - outcomeIndex` lefts, producing a natural-looking
-- trajectory that always lands in the correct bin.

DROP FUNCTION IF EXISTS play_plinko(BIGINT, INT, INT, TEXT);

CREATE OR REPLACE FUNCTION play_plinko(
  p_user_id    BIGINT,
  p_bet        INT,
  p_row_count  INT     DEFAULT 8,
  p_risk_level TEXT    DEFAULT 'LOW'
) RETURNS JSONB AS $$
DECLARE
  -- Config
  v_enabled       BOOLEAN;
  v_min_bet       INT;
  v_max_bet       INT;
  v_rtp           NUMERIC;

  -- Payout table
  v_all_payouts   JSONB;
  v_row_key       TEXT;
  v_multipliers_j JSONB;

  -- User
  v_balance       INT;

  -- Weights / multipliers
  v_n             INT;
  v_multipliers   NUMERIC[];
  v_base_weights  NUMERIC[];
  v_total_base    NUMERIC := 0;
  v_e_base        NUMERIC := 0;
  v_min_mult      NUMERIC;
  v_max_mult      NUMERIC;
  v_prob          NUMERIC;

  -- Exponential tilting calibration
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

  -- Outcome
  v_adj_weights   NUMERIC[];
  v_total_adj     NUMERIC := 0;
  v_rand          NUMERIC;
  v_cumulative    NUMERIC;
  v_outcome_idx   INT;
  v_multiplier    NUMERIC;
  v_payout        INT;
  v_new_balance   INT;

  -- Path generation
  v_path          INT[];
  v_num_rights    INT;
  v_j             INT;
  v_tmp           INT;
BEGIN
  -- ── 1. Validate params ──────────────────────────────────────────────────
  IF p_row_count < 8 OR p_row_count > 16 THEN
    RAISE EXCEPTION 'BUSINESS:Row count must be between 8 and 16';
  END IF;

  IF p_risk_level NOT IN ('LOW', 'MEDIUM', 'HIGH') THEN
    RAISE EXCEPTION 'BUSINESS:Risk level must be LOW, MEDIUM, or HIGH';
  END IF;

  -- ── 2. Load config ─────────────────────────────────────────────────────
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

  -- ── 3. Full payout table ───────────────────────────────────────────────
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

  v_row_key       := p_row_count::TEXT;
  v_multipliers_j := v_all_payouts -> v_row_key -> p_risk_level;

  IF v_multipliers_j IS NULL THEN
    RAISE EXCEPTION 'CONFIG:No payout data for rows=% risk=%', p_row_count, p_risk_level;
  END IF;

  -- ── 4. Build arrays ────────────────────────────────────────────────────
  v_n := jsonb_array_length(v_multipliers_j);
  v_multipliers  := array_fill(0::NUMERIC, ARRAY[v_n]);
  v_base_weights := array_fill(0::NUMERIC, ARRAY[v_n]);
  v_log_vals     := array_fill(0::NUMERIC, ARRAY[v_n]);

  -- Base weights from binomial distribution: C(rowCount, i) / 2^rowCount
  FOR v_i IN 0..v_n - 1 LOOP
    v_multipliers[v_i + 1] := (v_multipliers_j ->> v_i)::NUMERIC;

    -- Binomial coefficient weight: C(n, k) with n = p_row_count, k = v_i
    v_prob := 1;
    IF v_i > 0 THEN
      FOR v_iter IN 1..LEAST(v_i, p_row_count - v_i) LOOP
        v_prob := v_prob * (p_row_count - LEAST(v_i, p_row_count - v_i) + v_iter) / v_iter;
      END LOOP;
    END IF;
    v_base_weights[v_i + 1] := v_prob;
    v_total_base := v_total_base + v_prob;
  END LOOP;

  -- Compute base expected value and min/max multipliers
  v_min_mult := v_multipliers[1];
  v_max_mult := v_multipliers[1];
  FOR v_i IN 1..v_n LOOP
    v_e_base := v_e_base + (v_base_weights[v_i] / v_total_base) * v_multipliers[v_i];
    IF v_multipliers[v_i] < v_min_mult THEN v_min_mult := v_multipliers[v_i]; END IF;
    IF v_multipliers[v_i] > v_max_mult THEN v_max_mult := v_multipliers[v_i]; END IF;
  END LOOP;

  IF v_min_mult <= 0 THEN
    RAISE EXCEPTION 'CONFIG:all plinko multipliers must be positive';
  END IF;

  IF v_rtp < v_min_mult OR v_rtp > v_max_mult THEN
    RAISE EXCEPTION 'CONFIG:plinko_rtp % is outside achievable range [%, %]',
      v_rtp, v_min_mult, v_max_mult;
  END IF;

  -- ── 5. Calibrate sampling probabilities via binary search ──────────────
  IF v_rtp != v_e_base THEN
    v_alpha_lo := -20.0;
    v_alpha_hi :=  20.0;

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
        v_ew  := exp(v_log_vals[v_i] - v_log_max);
        v_sw  := v_sw  + v_ew;
        v_swm := v_swm + v_ew * v_multipliers[v_i];
      END LOOP;
      v_e_at_alpha := v_swm / v_sw;

      EXIT WHEN abs(v_e_at_alpha - v_rtp) < 1e-9;
      IF v_e_at_alpha < v_rtp THEN
        v_alpha_lo := v_alpha;
      ELSE
        v_alpha_hi := v_alpha;
      END IF;
    END LOOP;
  END IF;

  -- ── 6. Compute final adjusted weights ──────────────────────────────────
  v_log_max := -1e30;
  FOR v_i IN 1..v_n LOOP
    v_lv := ln(v_base_weights[v_i]) + v_alpha * ln(v_multipliers[v_i]);
    v_log_vals[v_i] := v_lv;
    IF v_lv > v_log_max THEN v_log_max := v_lv; END IF;
  END LOOP;

  v_adj_weights := array_fill(0::NUMERIC, ARRAY[v_n]);
  v_total_adj   := 0;
  FOR v_i IN 1..v_n LOOP
    v_ew               := exp(v_log_vals[v_i] - v_log_max);
    v_adj_weights[v_i] := v_ew;
    v_total_adj        := v_total_adj + v_ew;
  END LOOP;

  -- ── 7. Lock user row and validate balance ──────────────────────────────
  SELECT balance INTO v_balance
  FROM users WHERE telegram_id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BUSINESS:User not found';
  END IF;

  IF v_balance < p_bet THEN
    RAISE EXCEPTION 'BUSINESS:Insufficient balance';
  END IF;

  -- ── 8. Insert bet transaction and debit balance ────────────────────────
  INSERT INTO transactions (user_id, amount, type, game)
  VALUES (p_user_id, -p_bet, 'bet', 'plinko');

  UPDATE users SET balance = balance - p_bet WHERE telegram_id = p_user_id;

  -- ── 9. Select outcome using calibrated weights ─────────────────────────
  v_rand       := random() * v_total_adj;
  v_cumulative := 0;
  v_outcome_idx := v_n - 1;
  FOR v_i IN 1..v_n LOOP
    v_cumulative := v_cumulative + v_adj_weights[v_i];
    IF v_rand < v_cumulative THEN
      v_outcome_idx := v_i - 1;
      EXIT;
    END IF;
  END LOOP;

  v_multiplier := v_multipliers[v_outcome_idx + 1];
  v_payout     := floor(p_bet::NUMERIC * v_multiplier)::INT;

  -- ── 10. Generate path (Fisher-Yates shuffle) ──────────────────────────
  -- Build array with v_outcome_idx 1s (right) and (p_row_count - v_outcome_idx) 0s (left),
  -- then shuffle it to produce a random-looking but deterministic path.
  v_path := array_fill(0, ARRAY[p_row_count]);
  v_num_rights := v_outcome_idx;
  FOR v_i IN 1..v_num_rights LOOP
    v_path[v_i] := 1;
  END LOOP;

  -- Fisher-Yates shuffle
  FOR v_i IN REVERSE p_row_count..2 LOOP
    v_j := 1 + floor(random() * v_i)::INT;
    IF v_j != v_i THEN
      v_tmp := v_path[v_i];
      v_path[v_i] := v_path[v_j];
      v_path[v_j] := v_tmp;
    END IF;
  END LOOP;

  -- ── 11. Insert win transaction and credit balance ──────────────────────
  INSERT INTO transactions (user_id, amount, type, game)
  VALUES (p_user_id, v_payout, 'win', 'plinko');

  UPDATE users SET balance = balance + v_payout
  WHERE telegram_id = p_user_id
  RETURNING balance INTO v_new_balance;

  -- ── 12. Record round ───────────────────────────────────────────────────
  INSERT INTO plinko_rounds (user_id, bet, outcome_index, multiplier, payout)
  VALUES (p_user_id, p_bet, v_outcome_idx, v_multiplier, v_payout);

  -- ── 13. Return result ──────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'outcomeIndex', v_outcome_idx,
    'multiplier',   v_multiplier,
    'payout',       v_payout,
    'newBalance',   v_new_balance,
    'path',         to_jsonb(v_path)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION play_plinko(BIGINT, INT, INT, TEXT) TO service_role;
