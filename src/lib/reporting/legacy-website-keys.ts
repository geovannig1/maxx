import type { LegacyVocabulary } from '@/lib/outcomes/legacy-vocabulary'

/**
 * Website event-card keys the report once named after one business's GA4 events, and their generic
 * names (website-event-groups.ts). Stored snapshots and saved reports keep their bytes and
 * fingerprints; the metric key and metric identity are upgraded when read (legacy-vocabulary.ts).
 * Labels, definitions and claim ids are history and are kept as stored, so references to them hold.
 */
export const LEGACY_WEBSITE_METRIC_VOCABULARY: LegacyVocabulary = {
  exact: {
    book_now_events: 'intent_events',
    'ga4.book_now_events': 'ga4.intent_events',
    contact_events: 'lead_events',
    'ga4.contact_events': 'ga4.lead_events',
  },
  prefixes: [],
}
