INSERT INTO game_config (key, value) VALUES
  ('rocket_enabled', 'true'),
  ('rocket_rtp', '0.93')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
