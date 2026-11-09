import { describe, it, expect } from 'vitest'
import {
  campaignIsCbo,
  resolveOptimizationUnit,
  suppressAdsetBudgetFlagUnderCbo,
  BUDGET_DECISION_FLAGS,
} from '@/lib/flags/optimization-unit'

// The doctrine "CBO → campaign, ABO → ad set" made executable: budget location tells us the optimization
// unit, and budget decisions (pause/scale) for an ad set are suppressed when its campaign is CBO.

describe('campaignIsCbo', () => {
  it('is CBO when a campaign-level daily or lifetime budget is set', () => {
    expect(campaignIsCbo({ daily_budget: 50, lifetime_budget: null })).toBe(true)
    expect(campaignIsCbo({ daily_budget: null, lifetime_budget: 1000 })).toBe(true)
  })
  it('is ABO when the campaign carries no budget (it lives on the ad sets)', () => {
    expect(campaignIsCbo({ daily_budget: null, lifetime_budget: null })).toBe(false)
  })
})

describe('resolveOptimizationUnit', () => {
  it('maps CBO → campaign and ABO → ad set', () => {
    expect(resolveOptimizationUnit(true)).toBe('campaign')
    expect(resolveOptimizationUnit(false)).toBe('adset')
  })
})

describe('suppressAdsetBudgetFlagUnderCbo', () => {
  it('suppresses pause/scale ad-set flags only under CBO', () => {
    expect(suppressAdsetBudgetFlagUnderCbo('loser', true)).toBe(true)
    expect(suppressAdsetBudgetFlagUnderCbo('scale_candidate', true)).toBe(true)
    // Under ABO the ad set IS the unit — keep them.
    expect(suppressAdsetBudgetFlagUnderCbo('loser', false)).toBe(false)
  })
  it('never suppresses non-budget flags (creative fatigue, watchlist, winner) even under CBO', () => {
    expect(suppressAdsetBudgetFlagUnderCbo('creative_refresh', true)).toBe(false)
    expect(suppressAdsetBudgetFlagUnderCbo('watchlist', true)).toBe(false)
    expect(suppressAdsetBudgetFlagUnderCbo('winner', true)).toBe(false)
    expect(suppressAdsetBudgetFlagUnderCbo('too_early', true)).toBe(false)
  })
  it('BUDGET_DECISION_FLAGS is exactly pause + scale', () => {
    expect([...BUDGET_DECISION_FLAGS].sort()).toEqual(['loser', 'scale_candidate'])
  })
})
