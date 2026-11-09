'use client'

import { useEffect } from 'react'
import type { EntityLevel } from '@/lib/metrics/catalog'
import { columnsForPerformancePreset, performancePresetFromSearch } from '@/lib/performance/presets'

export function usePerformancePresetColumns(
  level: EntityLevel,
  setVisibleKeys: (keys: string[]) => void,
) {
  useEffect(() => {
    const preset = performancePresetFromSearch(window.location.search)
    if (!preset) return
    setVisibleKeys(columnsForPerformancePreset(preset, level))
  }, [level, setVisibleKeys])
}
