import { executiveFixture } from './executive-fixture'
import { projectAudienceInventory } from '../../src/lib/reporting/audience-projection'
import { resolveInventoryAudience } from '../../src/lib/platforms/meta/reporting/meta-inventory'

/** Fictional native-shaped audience controls; no source fetch or live performance claims. */
export function audienceReportingFixture(from = '2026-09-02', to = '2026-09-04') {
  const base = executiveFixture(from, to, true)
  const inventory = projectAudienceInventory(base.context, [
    { id: 'healthy-pool', name: 'Website visitors', subtype: 'WEBSITE', retention_days: '180',
      approximate_count_lower_bound: '20', approximate_count_upper_bound: '20', operation_status: { code: 200 }, delivery_status: { code: 200 } },
    { id: 'failed-exclusion', name: 'Lookalike exclusion', subtype: 'LOOKALIKE', operation_status: { code: 433, description: 'Could not create lookalike' }, delivery_status: { code: 200, description: 'Ready for use' },
      approximate_count_lower_bound: -1, approximate_count_upper_bound: -1,
      lookalike_spec: { origin: [{ id: 'seed-a', name: 'Seed one' }, { id: 'seed-b', name: 'Seed two' }] } },
    { id: 'unknown-operation', name: 'Operation not supplied', subtype: 'ENGAGEMENT', delivery_status: { code: 200 } },
    { id: 'unused-failed', name: 'Unused failed audience', subtype: 'LOOKALIKE', operation_status: { code: 433 }, delivery_status: { code: 200 } },
  ])
  return { ...base, meta: { ...base.meta, data: { ...base.meta.data!,
    entities: base.meta.data!.entities.map(entity => {
      if (entity.level !== 'adset') return entity
      const id = entity.id
      const targeting = id === 'set-4' ? { flexible_spec: [{ interests: [{ id: 'photo-interest' }] }] } : {
        custom_audiences: [{ id: id === 'set-3' ? 'unknown-operation' : 'healthy-pool' }],
        excluded_custom_audiences: id === 'set-7' || id === 'set-8' ? [{ id: 'failed-exclusion' }]
          : id === 'set-6' ? [{ id: 'healthy-pool' }] : [],
        targeting_automation: { advantage_audience: id === 'set-2' ? 1 : 0 },
      }
      return { ...entity, status: id === 'set-8' ? 'PAUSED' : 'ACTIVE', configurationAsOf: base.context.asOf,
        ...resolveInventoryAudience(base.context, { id, name: entity.name, targeting }, inventory, base.context.asOf) }
    }), sourceDescription: 'Fictional audience readiness scenario; not connected account results.',
  } } }
}
