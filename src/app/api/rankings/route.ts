/**
 * Server-side ranking computation API.
 *
 * GET /api/rankings
 *
 * Returns cached rankings if algorithm_version matches and cache is not stale.
 * Otherwise recomputes from raw comparisons and updates cache.
 *
 * This ensures ranking integrity (server-computed, not client-only)
 * and provides a single source of truth for ranking data.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  computeRankingsDetailed,
  ALGORITHM_VERSION,
} from "@/lib/ranking/bradley-terry";
import type { Comparison, RankingEntry } from "@/types/database";

interface UserCourseRow {
  course_id: string;
}

interface CacheRow {
  rankings: RankingEntry[];
  algorithm_version: number;
  is_stale: boolean;
  computed_at: string;
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Rate limit: 30 requests per minute per user
  const limit = checkRateLimit(`rankings:${user.id}`, 30);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) },
      }
    );
  }

  // Check cache first
  const { data: cache } = (await supabase
    .from("user_ranking_cache")
    .select("rankings, algorithm_version, is_stale, computed_at")
    .eq("user_id", user.id)
    .single()) as { data: CacheRow | null };

  if (
    cache &&
    !cache.is_stale &&
    cache.algorithm_version === ALGORITHM_VERSION
  ) {
    return NextResponse.json({
      rankings: cache.rankings,
      cached: true,
      computed_at: cache.computed_at,
      algorithm_version: ALGORITHM_VERSION,
    });
  }

  // Cache miss or stale — recompute
  const [coursesRes, compsRes] = await Promise.all([
    supabase
      .from("user_courses")
      .select("course_id")
      .eq("user_id", user.id) as unknown as Promise<{
      data: UserCourseRow[] | null;
    }>,
    supabase
      .from("comparisons")
      .select("*")
      .eq("user_id", user.id) as unknown as Promise<{
      data: Comparison[] | null;
    }>,
  ]);

  const courseIds = (coursesRes.data ?? []).map((r) => r.course_id);
  const comparisons = compsRes.data ?? [];

  const result = computeRankingsDetailed(courseIds, comparisons);

  // Update cache
  const now = new Date().toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase.from("user_ranking_cache") as any).upsert(
    {
      user_id: user.id,
      rankings: result.rankings,
      is_stale: false,
      algorithm_version: ALGORITHM_VERSION,
      computed_at: now,
    },
    { onConflict: "user_id" }
  );

  return NextResponse.json({
    rankings: result.rankings,
    cached: false,
    computed_at: now,
    algorithm_version: ALGORITHM_VERSION,
    converged: result.converged,
    iterations: result.iterations,
  });
}
