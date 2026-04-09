export enum RiskLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
}

export enum BetMode {
  MANUAL = 'MANUAL',
  AUTO = 'AUTO',
}

export const rowCountOptions = [8, 9, 10, 11, 12, 13, 14, 15, 16] as const
export type RowCount = (typeof rowCountOptions)[number]

export interface WinRecord {
  id: string
  betAmount: number
  rowCount: RowCount
  binIndex: number
  payout: {
    multiplier: number
    value: number
  }
  profit: number
}
