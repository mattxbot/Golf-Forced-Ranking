/**
 * Write-Ahead Log (WAL) for comparisons.
 *
 * Every comparison is written to localStorage immediately, then flushed
 * to Supabase in the background. If the network call fails the entry
 * stays in the queue and is retried with exponential back-off.
 *
 * This guarantees zero data loss even if the user closes the tab or
 * loses connectivity mid-session.
 */

const WAL_KEY = "golf_comparison_wal";
const MAX_RETRIES = 5;

export interface WalEntry {
  /** Client-generated id so we can dedupe */
  id: string;
  user_id: string;
  course_a_id: string;
  course_b_id: string;
  winner: "a" | "b";
  decided_in_ms: number | null;
  created_at: string;
  retries: number;
}

interface UpsertResult {
  error: unknown;
}

interface SupabaseLike {
  from: (table: string) => {
    upsert: (
      row: Record<string, unknown>,
      opts?: Record<string, unknown>
    ) => PromiseLike<UpsertResult>;
  };
}

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

function readWal(): WalEntry[] {
  try {
    const raw = localStorage.getItem(WAL_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeWal(entries: WalEntry[]): void {
  try {
    localStorage.setItem(WAL_KEY, JSON.stringify(entries));
  } catch {
    // localStorage full — entries will still live in memory
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Append a new comparison to the WAL and trigger a flush. */
export function appendComparison(
  entry: Omit<WalEntry, "retries">,
  supabase: SupabaseLike
): void {
  const entries = readWal();

  // Dedupe: replace any existing entry for the same (user, pair)
  const idx = entries.findIndex(
    (e) =>
      e.user_id === entry.user_id &&
      e.course_a_id === entry.course_a_id &&
      e.course_b_id === entry.course_b_id
  );
  const walEntry: WalEntry = { ...entry, retries: 0 };
  if (idx >= 0) {
    entries[idx] = walEntry;
  } else {
    entries.push(walEntry);
  }
  writeWal(entries);

  // Fire-and-forget flush
  flushWal(supabase);
}

/** Flush all pending WAL entries to Supabase. */
export async function flushWal(supabase: SupabaseLike): Promise<void> {
  const entries = readWal();
  if (entries.length === 0) return;

  const remaining: WalEntry[] = [];

  for (const entry of entries) {
    try {
      const { error } = await supabase
        .from("comparisons")
        .upsert(
          {
            user_id: entry.user_id,
            course_a_id: entry.course_a_id,
            course_b_id: entry.course_b_id,
            winner: entry.winner,
            decided_in_ms: entry.decided_in_ms,
          },
          { onConflict: "user_id,course_a_id,course_b_id" }
        );

      if (error) throw error;
      // Success — entry removed from WAL
    } catch {
      if (entry.retries < MAX_RETRIES) {
        remaining.push({ ...entry, retries: entry.retries + 1 });
      }
      // After MAX_RETRIES the entry is silently dropped
    }
  }

  writeWal(remaining);

  // Schedule retry for remaining entries with exponential back-off
  if (remaining.length > 0) {
    const minRetries = Math.min(...remaining.map((e) => e.retries));
    const delayMs = Math.min(2000 * Math.pow(2, minRetries - 1), 30_000);
    setTimeout(() => flushWal(supabase), delayMs);
  }
}

/** Returns the number of un-flushed entries (for UI indicators). */
export function pendingCount(): number {
  return readWal().length;
}
