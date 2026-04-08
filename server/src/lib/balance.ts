import { supabase } from './supabase'

export async function creditBalance(
  userId: number,
  amount: number,
  type: string,
  game?: string,
  referenceId?: string
): Promise<{ newBalance: number }> {
  const { data, error } = await supabase.rpc('credit_balance', {
    p_user_id: userId,
    p_amount: amount,
    p_type: type,
    p_game: game ?? null,
    p_reference_id: referenceId ?? null,
  })

  if (error) throw new Error(error.message)
  return { newBalance: data as number }
}

export async function debitBalance(
  userId: number,
  amount: number,
  type: string,
  game?: string,
  referenceId?: string
): Promise<{ newBalance: number }> {
  const { data, error } = await supabase.rpc('debit_balance', {
    p_user_id: userId,
    p_amount: amount,
    p_type: type,
    p_game: game ?? null,
    p_reference_id: referenceId ?? null,
  })

  if (error) {
    if (error.message.includes('Insufficient balance')) {
      throw new Error('Insufficient balance')
    }
    throw new Error(error.message)
  }
  return { newBalance: data as number }
}
