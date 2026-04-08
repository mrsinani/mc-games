INSERT INTO game_config (key, value) VALUES
  ('plinko_enabled', 'true'),
  ('rocket_enabled', 'true'),
  ('pvp_enabled', 'false'),
  ('plinko_rtp', '0.95'),
  ('rocket_rtp', '0.93'),
  ('pvp_house_cut', '0.05'),
  ('min_bet', '10'),
  ('max_bet', '10000'),
  ('plinko_weights', '[{"bucket": "far_edge", "multiplier": 0.2, "weight": 20}, {"bucket": "mid", "multiplier": 0.5, "weight": 30}, {"bucket": "center_ish", "multiplier": 1.5, "weight": 30}, {"bucket": "center", "multiplier": 3.0, "weight": 15}, {"bucket": "bullseye", "multiplier": 10.0, "weight": 5}]')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
