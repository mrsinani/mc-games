-- Make crash_at nullable so a rocket_rounds row can be created at betting open
ALTER TABLE rocket_rounds ALTER COLUMN crash_at DROP NOT NULL;

-- Enforce one bet per user per round at the DB level
CREATE UNIQUE INDEX idx_rocket_entries_round_user ON rocket_entries(round_id, user_id);
