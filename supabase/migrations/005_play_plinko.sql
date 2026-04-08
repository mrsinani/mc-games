-- Migration 005: play_plinko atomic RPC
--
-- Implements the complete Plinko play lifecycle in a single transaction:
-- config validation, balance debit, RTP-calibrated outcome selection,
-- payout credit, and round recording. All mutations commit or roll back
-- together, preventing partial-failure balance corruption.
--
-- RTP Calibration model (exponential tilting):
--
--   tilted_weight_i = base_weight_i * multiplier_i ^ alpha
--   adjusted_prob_i = tilted_weight_i / Σ tilted_weight_j
--   E[multiplier | alpha] = Σ adjusted_prob_i * multiplier_i
--
--   alpha = 0  → base distribution (E = e_base computed from plinko_weights)
--   alpha < 0  → mass shifts toward lower multipliers (use when rtp < e_base)
--   alpha > 0  → mass shifts toward higher multipliers (use when rtp > e_base)
--
--   Binary search over alpha in [-20, 20] finds the value where E = plinko_rtp.
--   Log-space arithmetic prevents overflow for extreme alpha values.
--   Convergence: |E − rtp| < 1e-9 or 60 iterations, whichever comes first.
--   Multipliers are never modified; only sampling probabilities are adjusted.

CREATE OR REPLACE FUNCTION play_plinko(
  p_user_id BIGINT,
  p_bet     INT
) RETURNS JSONB AS $$
DECLARE
  -- Config
  v_enabled       BOOLEAN;
  v_min_bet       INT;
  v_max_bet       INT;
  v_rtp           NUMERIC;
  v_weights_json  JSONB;

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
BEGIN
  -- ── 1. Load config ────────────────────────────────────────────────────────
  SELECT
    (SELECT value::boolean  FROM game_config WHERE key = 'plinko_enabled'),
    (SELECT value::int      FROM game_config WHERE key = 'min_bet'),
    (SELECT value::int      FROM game_config WHERE key = 'max_bet'),
    (SELECT value::numeric  FROM game_config WHERE key = 'plinko_rtp'),
    (SELECT value           FROM game_config WHERE key = 'plinko_weights')
  INTO v_enabled, v_min_bet, v_max_bet, v_rtp, v_weights_json;

  -- ── 2. Validate plinko_enabled ────────────────────────────────────────────
  IF NOT COALESCE(v_enabled, FALSE) THEN
    RAISE EXCEPTION 'BUSINESS:Plinko is currently disabled';
  END IF;

  -- ── 3. Validate bet range ─────────────────────────────────────────────────
  IF p_bet < v_min_bet OR p_bet > v_max_bet THEN
    RAISE EXCEPTION 'BUSINESS:Bet must be between % and %', v_min_bet, v_max_bet;
  END IF;

  -- ── 4. Validate weights config ────────────────────────────────────────────
  v_n := jsonb_array_length(v_weights_json);
  IF v_n = 0 THEN
    RAISE EXCEPTION 'CONFIG:plinko_weights is empty';
  END IF;

  -- Extract multipliers and base weights into 1-indexed arrays
  v_multipliers  := array_fill(0::NUMERIC, ARRAY[v_n]);
  v_base_weights := array_fill(0::NUMERIC, ARRAY[v_n]);
  v_log_vals     := array_fill(0::NUMERIC, ARRAY[v_n]);

  FOR v_i IN 0..v_n - 1 LOOP
    v_multipliers [v_i + 1] := (v_weights_json -> v_i ->> 'multiplier')::NUMERIC;
    v_base_weights[v_i + 1] := (v_weights_json -> v_i ->> 'weight')::NUMERIC;
    v_total_base             := v_total_base + v_base_weights[v_i + 1];
  END LOOP;

  IF v_total_base <= 0 THEN
    RAISE EXCEPTION 'CONFIG:plinko_weights total weight must be positive';
  END IF;

  -- Compute base expected value and find min/max multipliers
  v_min_mult := v_multipliers[1];
  v_max_mult := v_multipliers[1];
  FOR v_i IN 1..v_n LOOP
    v_e_base := v_e_base + (v_base_weights[v_i] / v_total_base) * v_multipliers[v_i];
    IF v_multipliers[v_i] < v_min_mult THEN v_min_mult := v_multipliers[v_i]; END IF;
    IF v_multipliers[v_i] > v_max_mult THEN v_max_mult := v_multipliers[v_i]; END IF;
  END LOOP;

  -- All multipliers must be positive (required for ln() in calibration)
  IF v_min_mult <= 0 THEN
    RAISE EXCEPTION 'CONFIG:all plinko multipliers must be positive';
  END IF;

  -- Validate RTP is achievable given the configured multiplier range
  IF v_rtp < v_min_mult OR v_rtp > v_max_mult THEN
    RAISE EXCEPTION 'CONFIG:plinko_rtp % is outside achievable range [%, %]',
      v_rtp, v_min_mult, v_max_mult;
  END IF;

  -- ── 5. Calibrate sampling probabilities via binary search ─────────────────
  IF v_rtp != v_e_base THEN
    v_alpha_lo := -20.0;
    v_alpha_hi :=  20.0;

    FOR v_iter IN 1..60 LOOP
      v_alpha := (v_alpha_lo + v_alpha_hi) / 2.0;

      -- Compute log(base_weight_i) + alpha * log(multiplier_i), track max
      v_log_max := -1e30;
      FOR v_i IN 1..v_n LOOP
        v_lv := ln(v_base_weights[v_i]) + v_alpha * ln(v_multipliers[v_i]);
        v_log_vals[v_i] := v_lv;
        IF v_lv > v_log_max THEN v_log_max := v_lv; END IF;
      END LOOP;

      -- Numerically stable E[m | alpha]
      v_sw := 0;  v_swm := 0;
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

  -- ── 6. Compute final adjusted weights at converged alpha ──────────────────
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

  -- ── 7. Lock user row and validate balance ─────────────────────────────────
  SELECT balance INTO v_balance
  FROM users WHERE telegram_id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BUSINESS:User not found';
  END IF;

  IF v_balance < p_bet THEN
    RAISE EXCEPTION 'BUSINESS:Insufficient balance';
  END IF;

  -- ── 8. Insert bet transaction and debit balance ───────────────────────────
  INSERT INTO transactions (user_id, amount, type, game)
  VALUES (p_user_id, -p_bet, 'bet', 'plinko');

  UPDATE users SET balance = balance - p_bet WHERE telegram_id = p_user_id;

  -- ── 9. Select outcome using calibrated weights ────────────────────────────
  v_rand        := random() * v_total_adj;
  v_cumulative  := 0;
  v_outcome_idx := v_n - 1;  -- default to last bucket if loop doesn't exit early
  FOR v_i IN 1..v_n LOOP
    v_cumulative := v_cumulative + v_adj_weights[v_i];
    IF v_rand < v_cumulative THEN
      v_outcome_idx := v_i - 1;  -- 0-indexed for client
      EXIT;
    END IF;
  END LOOP;

  v_multiplier := v_multipliers[v_outcome_idx + 1];
  v_payout     := floor(p_bet::NUMERIC * v_multiplier)::INT;

  -- ── 10. Insert win transaction and credit balance (always, even for 0) ────
  INSERT INTO transactions (user_id, amount, type, game)
  VALUES (p_user_id, v_payout, 'win', 'plinko');

  UPDATE users SET balance = balance + v_payout
  WHERE telegram_id = p_user_id
  RETURNING balance INTO v_new_balance;

  -- ── 11. Record round ──────────────────────────────────────────────────────
  INSERT INTO plinko_rounds (user_id, bet, outcome_index, multiplier, payout)
  VALUES (p_user_id, p_bet, v_outcome_idx, v_multiplier, v_payout);

  -- ── 12. Return result ─────────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'outcomeIndex', v_outcome_idx,
    'multiplier',   v_multiplier,
    'payout',       v_payout,
    'newBalance',   v_new_balance
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Allow the service role (used by the Express backend) to call this function.
GRANT EXECUTE ON FUNCTION play_plinko(BIGINT, INT) TO service_role;
