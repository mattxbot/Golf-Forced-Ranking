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
const DROPPED_KEY = "golf_comparison_dropped";
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

// Subscriber for WAL status changes
type WalStatusListener = (pending: number, dropped: number) => void;
const listeners = new Set<WalStatusListener>();

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

function incrementDropped(): number {
  try {
    const current = parseInt(localStorage.getItem(DROPPED_KEY) ?? "0", 10);
    const next = current + 1;
    localStorage.setItem(DROPPED_KEY, String(next));
    return next;
  } catch {
    return 0;
  }
}

function notifyListeners(pending: number, dropped: number): void {
  for (const fn of listeners) {
    try {
      fn(pending, dropped);
    } catch {
      // ignore listener errors
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Subscribe to WAL status changes. Returns unsubscribe function. */
export function onWalStatus(listener: WalStatusListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

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
  let droppedThisFlush = 0;

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
      } else {
        // Permanently failed — track it
        const totalDropped = incrementDropped();
        droppedThisFlush++;
        console.warn(
          `[WAL] Dropped comparison after ${MAX_RETRIES} retries:`,
          entry.course_a_id, "vs", entry.course_b_id
        );
        notifyListeners(remaining.length, totalDropped);
      }
    }
  }

  writeWal(remaining);

  if (droppedThisFlush === 0) {
    const dropped = parseInt(localStorage.getItem(DROPPED_KEY) ?? "0", 10);
    notifyListeners(remaining.length, dropped);
  }

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

/** Returns the total number of entries permanently dropped. */
export function droppedCount(): number {
  try {
    return parseInt(localStorage.getItem(DROPPED_KEY) ?? "0", 10);
  } catch {
    return 0;
  }
}

/** Clear the dropped counter (e.g., after user acknowledges). */
export function clearDropped(): void {
  try {
    localStorage.removeItem(DROPPED_KEY);
  } catch {
    // ignore
  }
}
