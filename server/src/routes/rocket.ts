import { Router, Request, Response } from 'express'
import { authMiddleware } from '../middleware/auth'
import { supabase } from '../lib/supabase'
import { debitBalance, creditBalance } from '../lib/balance'
import {
  getRoundState,
  placeBet,
  prepareCashout,
  confirmCashout,
  rollbackCashout,
  getCurrentRoundId,
  emitToUser,
} from '../game/rocketEngine'

const router = Router()

function coerceBool(val: unknown, defaultVal: boolean): boolean {
  if (val === true || val === 'true') return true
  if (val === false || val === 'false') return false
  return defaultVal
}

function coerceNumber(val: unknown, defaultVal: number): number {
  if (typeof val === 'number' && isFinite(val)) return val
  if (typeof val === 'string') {
    const n = parseFloat(val)
    if (isFinite(n)) return n
  }
  return defaultVal
}

router.post('/bet', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { telegram_id } = req.user!
  const { bet } = req.body as { bet: unknown }

  if (typeof bet !== 'number' || !Number.isFinite(bet) || bet <= 0) {
    res.status(400).json({ error: 'Invalid bet amount' })
    return
  }

  // Validate config
  const { data: configRows } = await supabase
    .from('game_config')
    .select('key, value')
    .in('key', ['rocket_enabled', 'min_bet', 'max_bet'])

  const config: Record<string, unknown> = {}
  for (const row of configRows ?? []) {
    config[row.key as string] = row.value
  }

  if (!coerceBool(config['rocket_enabled'], false)) {
    res.status(400).json({ error: 'Rocket game is disabled' })
    return
  }

  const minBet = coerceNumber(config['min_bet'], 10)
  const maxBet = coerceNumber(config['max_bet'], 10000)

  if (bet < minBet || bet > maxBet) {
    res.status(400).json({ error: `Bet must be between ${minBet} and ${maxBet}` })
    return
  }

  const roundState = getRoundState()
  if (roundState.phase !== 'betting') {
    res.status(400).json({ error: 'Round is not in betting phase' })
    return
  }

  // Debit balance atomically
  let newBalance: number
  try {
    const result = await debitBalance(telegram_id, bet, 'bet', 'rocket')
    newBalance = result.newBalance
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to debit balance'
    res.status(400).json({ error: msg })
    return
  }

  // Insert entry into DB
  const { data: entryData, error: insertError } = await supabase
    .from('rocket_entries')
    .insert({
      round_id: roundState.roundId,
      user_id: telegram_id,
      bet,
    })
    .select('id')
    .single()

  if (insertError || !entryData) {
    // Refund the bet
    await creditBalance(telegram_id, bet, 'refund', 'rocket').catch(() => {})
    res.status(500).json({ error: 'Failed to place bet' })
    return
  }

  // Register bet in engine
  const registered = placeBet(telegram_id, entryData.id as string, bet)
  if (!registered.ok) {
    // Round ended or user already has an active bet — delete DB entry and refund
    await supabase.from('rocket_entries').delete().eq('id', entryData.id).catch(() => {})
    await creditBalance(telegram_id, bet, 'refund', 'rocket').catch(() => {})
    const error =
      registered.reason === 'duplicate'
        ? 'You already have an active bet for this round'
        : 'Round is no longer in betting phase'
    res.status(400).json({ error })
    return
  }

  res.json({ success: true, balance: newBalance })
})

router.post('/cashout', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { telegram_id } = req.user!

  // Prepare cashout without mutating in-memory state yet
  const prepared = prepareCashout(telegram_id)
  if (!prepared) {
    res.status(400).json({ error: 'Cannot cash out right now' })
    return
  }

  const { multiplier, payout, entryId } = prepared
  const roundId = getCurrentRoundId()

  // Credit payout
  let newBalance: number
  try {
    const balanceResult = await creditBalance(telegram_id, payout, 'win', 'rocket')
    newBalance = balanceResult.newBalance
  } catch (err) {
    // Restore eligibility so user can retry
    rollbackCashout(telegram_id)
    const msg = err instanceof Error ? err.message : 'Failed to credit payout'
    res.status(500).json({ error: msg })
    return
  }

  // Update entry by id
  const { error: updateError } = await supabase
    .from('rocket_entries')
    .update({ cashout_at: multiplier, payout })
    .eq('id', entryId)

  if (updateError) {
    // Restore eligibility so user can retry
    rollbackCashout(telegram_id)
    res.status(500).json({ error: 'Failed to record cashout' })
    return
  }

  // Both persistence steps succeeded — confirm in-memory state
  confirmCashout(telegram_id, multiplier)

  // Emit cashout:confirmed to user's socket
  emitToUser(telegram_id, 'cashout:confirmed', { cashoutAt: multiplier, payout, newBalance })

  res.json({ success: true, cashoutAt: multiplier, payout, newBalance })

  void roundId // referenced for potential future use
})

export default router
