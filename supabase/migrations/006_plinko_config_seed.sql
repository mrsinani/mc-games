-- Migration 006: Seed game_config with plinko defaults
--
-- Inserts default values for all keys consumed by play_plinko and the
-- client config endpoint.  Uses ON CONFLICT DO NOTHING so re-running this
-- migration (or running it against a DB that already has values) is safe.

INSERT INTO game_config (key, value) VALUES
  ('plinko_enabled', 'true'::jsonb),
  ('min_bet',        '10'::jsonb),
  ('max_bet',        '10000'::jsonb),
  ('plinko_rtp',     '0.95'::jsonb),
  ('plinko_weights', '[
    {"multiplier": 0.2, "weight": 400},
    {"multiplier": 0.5, "weight": 300},
    {"multiplier": 1.5, "weight": 200},
    {"multiplier": 3.0, "weight":  80},
    {"multiplier": 10.0,"weight":  20}
  ]'::jsonb),
  ('rocket_enabled', 'false'::jsonb),
  ('pvp_enabled',    'false'::jsonb)
ON CONFLICT (key) DO NOTHING;
