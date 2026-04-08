-- Re-apply balance functions with explicit game parameter (idempotent via CREATE OR REPLACE)
CREATE OR REPLACE FUNCTION credit_balance(
  p_user_id BIGINT,
  p_amount INT,
  p_type TEXT,
  p_game TEXT DEFAULT NULL,
  p_reference_id UUID DEFAULT NULL
) RETURNS INT AS $$
DECLARE
  new_balance INT;
BEGIN
  INSERT INTO transactions (user_id, amount, type, game, reference_id)
  VALUES (p_user_id, p_amount, p_type, p_game, p_reference_id);

  UPDATE users SET balance = balance + p_amount
  WHERE telegram_id = p_user_id
  RETURNING balance INTO new_balance;

  RETURN new_balance;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION debit_balance(
  p_user_id BIGINT,
  p_amount INT,
  p_type TEXT,
  p_game TEXT DEFAULT NULL,
  p_reference_id UUID DEFAULT NULL
) RETURNS INT AS $$
DECLARE
  current_bal INT;
  new_balance INT;
BEGIN
  SELECT balance INTO current_bal FROM users WHERE telegram_id = p_user_id FOR UPDATE;

  IF current_bal < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance';
  END IF;

  INSERT INTO transactions (user_id, amount, type, game, reference_id)
  VALUES (p_user_id, -p_amount, p_type, p_game, p_reference_id);

  UPDATE users SET balance = balance - p_amount
  WHERE telegram_id = p_user_id
  RETURNING balance INTO new_balance;

  RETURN new_balance;
END;
$$ LANGUAGE plpgsql;