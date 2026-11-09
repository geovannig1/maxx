import type {
  WeeklyExecutiveDeliveryAttemptStatus,
  WeeklyExecutiveDeliveryLedger,
} from '@/lib/report/weekly-executive-delivery'
import { getAdminClient } from '@/lib/supabase/admin'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function createWeeklyExecutiveDeliveryLedger(): WeeklyExecutiveDeliveryLedger {
  return {
    async claim(input) {
      const db = getAdminClient()
      const write = await db
        .from('weekly_executive_delivery_attempts')
        .insert({
          report_id: input.reportId,
          provider: input.provider,
          recipient: input.recipient,
          payload_fingerprint: input.payloadFingerprint,
          message_id: input.messageId,
        })
        .select('id')
        .single()

      if (!write.error) {
        const attemptId = write.data?.id
        if (typeof attemptId !== 'string' || !UUID_PATTERN.test(attemptId)) {
          throw new Error('Weekly executive delivery claim returned an invalid identity.')
        }
        return { status: 'claimed', attemptId }
      }
      if (write.error.code !== '23505') throw new Error('Weekly executive delivery claim failed.')

      const existing = await db
        .from('weekly_executive_delivery_attempts')
        .select('status')
        .eq('report_id', input.reportId)
        .eq('recipient', input.recipient)
        .maybeSingle()
      const attemptStatus = existing.data?.status
      if (existing.error || !['claimed', 'sent', 'failed', 'ambiguous'].includes(attemptStatus)) {
        throw new Error('Weekly executive delivery claim could not be verified.')
      }
      return {
        status: 'already_attempted',
        attemptStatus: attemptStatus as WeeklyExecutiveDeliveryAttemptStatus,
      }
    },

    async complete(input) {
      const completed = await getAdminClient()
        .from('weekly_executive_delivery_attempts')
        .update({
          status: input.status,
          provider_message_id: input.providerMessageId ?? null,
          completed_at: new Date().toISOString(),
        })
        .eq('id', input.attemptId)
        .eq('status', 'claimed')
        .select('id')
        .maybeSingle()
      if (completed.error || completed.data?.id !== input.attemptId) {
        throw new Error('Weekly executive delivery completion failed.')
      }
    },
  }
}
