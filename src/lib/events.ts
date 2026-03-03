/**
 * Lightweight event tracking for implicit signal capture.
 * [RecSys Review Fix #2]
 *
 * Write-only: events are never read by the MVP client.
 * Phase 2 ML pipeline reads these for feature engineering.
 */

export type EventType =
  | "search_query"
  | "course_view"
  | "course_add"
  | "course_remove"
  | "comparison_presented"
  | "comparison_skipped"
  | "comparison_completed"
  | "session_start"
  | "session_end";

interface SupabaseLike {
  from: (table: string) => {
    insert: (row: Record<string, unknown>) => { then: () => void };
  };
}

/**
 * Log an implicit signal event. Fire-and-forget — never blocks UI.
 */
export function trackEvent(
  supabase: SupabaseLike,
  userId: string,
  eventType: EventType,
  payload: Record<string, unknown> = {}
) {
  supabase
    .from("user_events")
    .insert({ user_id: userId, event_type: eventType, payload })
    .then();
}
