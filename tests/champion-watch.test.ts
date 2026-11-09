import { describe, expect, it } from 'vitest'
import { CHAMPION_WATCH_STATUS, runChampionWatch } from '@/lib/economics/champion-watch'

describe('historical champion watch is inert', () => {
  it('returns zero and advertises no current action authority', async () => {
    await expect(runChampionWatch('account-1')).resolves.toBe(0)
    expect(CHAMPION_WATCH_STATUS).toEqual({
      status: 'disabled',
      reason_code: 'historical_benchmark_has_no_current_authority',
      action_authority: 'none',
    })
  })
})
