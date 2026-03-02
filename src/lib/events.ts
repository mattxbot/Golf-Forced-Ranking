/**
 * Lightweight event tracking for implicit signal capture.
 * [RecSys Review Fix #2]
 *
 * Write-only: events are never read by the MVP client.
 * Phase 2 ML pipeline reads these for feature engineering.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type EventType =
  | "search_query"
  | "course_view"
  | "course_add"
  | "course_remove"
  | "comparison_presented"
  | "comparison_skipped"
  | "comparison_completed"
  | "session_start"
  | "session_end";

/**
 * Log an implicit signal event. Fire-and-forget — never blocks UI.
 */
export function trackEvent(
  supabase: SupabaseClient<Database>,
  userId: string,
  eventType: EventType,
  payload: Record<string, unknown> = {}
) {
  // Non-blocking insert
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (supabase.from("user_events") as any)
    .insert({ user_id: userId, event_type: eventType, payload })
    .then();
}
