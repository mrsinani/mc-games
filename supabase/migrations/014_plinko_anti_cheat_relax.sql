  -- Relax Plinko rolling-RTP freeze: the old rule (50 rounds, payout/bet > 1.5) froze
  -- legitimate players after a single large win because sum(payout)/sum(bet) spikes.
  -- New defaults: longer window, higher RTP bar, and only evaluate after enough rounds.

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

    v_window_size   INT     := 200;
    v_max_rtp       NUMERIC := 2.85;
    v_min_rounds    INT     := 80;
    v_recent_count  INT;
    v_recent_bets   NUMERIC;
    v_recent_wins   NUMERIC;
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

    SELECT COUNT(*)::INT, COALESCE(SUM(bet), 0), COALESCE(SUM(payout), 0)
    INTO v_recent_count, v_recent_bets, v_recent_wins
    FROM (
      SELECT bet, payout
      FROM plinko_rounds
      WHERE user_id = p_user_id
      ORDER BY created_at DESC
      LIMIT v_window_size
    ) r;

    IF
      v_recent_count >= v_min_rounds
      AND v_recent_bets > 0
      AND (v_recent_wins / v_recent_bets) > v_max_rtp
    THEN
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

  GRANT EXECUTE ON FUNCTION settle_plinko(BIGINT, UUID, INT) TO service_role;
