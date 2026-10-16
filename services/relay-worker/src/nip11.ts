import { MAX_EVENT_BYTES, MAX_FUTURE_SECONDS } from '@smartcity/schemas'
import type { Config } from './config.js'
import { MAX_FILTERS, MAX_LIMIT, MAX_SUBSCRIPTIONS } from './filter.js'

const DAY = 86_400

/** NIP-11 relay information document: limits, policy and retention (docs/spec/07, RELAY-5). */
export function relayInfo(config: Config) {
  return {
    name: config.name,
    description: 'Relay de referencia SmartCity: valida firma y esquema de los eventos de docs/spec/03.',
    contact: config.contact || undefined,
    supported_nips: [1, 9, 11, 13, 40],
    software: 'https://github.com/AdanRuiz/smartcityd/tree/main/services/relay-worker',
    version: '0.1.0',
    limitation: {
      max_message_length: MAX_EVENT_BYTES * 2,
      max_content_length: MAX_EVENT_BYTES,
      max_subscriptions: MAX_SUBSCRIPTIONS,
      max_filters: MAX_FILTERS,
      max_limit: MAX_LIMIT,
      default_limit: MAX_LIMIT,
      auth_required: false,
      payment_required: false,
      restricted_writes: config.cities !== null || config.writePolicy === 'roles',
      created_at_lower_limit: config.maxEventAgeDays > 0 ? config.maxEventAgeDays * DAY : undefined,
      created_at_upper_limit: MAX_FUTURE_SECONDS,
    },
    // The relay does not purge yet (RELAY-4 until phase 4); RETENTION_DAYS is the announced target.
    retention: [{ time: config.retentionDays * DAY }],
    smartcity: {
      cities: config.cities ?? ['*'],
      write_policy: config.writePolicy,
      trust_anchors: config.trustAnchors,
      // NIP-13 bits asked of `report` from keys without a role (SPAM-1).
      pow_bits_report: config.powBitsReport,
      rate_events_per_min: config.rateEventsPerMin,
      max_event_age_days: config.maxEventAgeDays,
      retention_days: config.retentionDays,
    },
  }
}
