/**
 * POST /api/share
 *
 * Creates a shareable snapshot of the authenticated user's current rankings.
 * Rate limited to 10 shares per hour per user.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { computeRankings, overallConfidence } from "@/lib/ranking/bradley-terry";
import type { Comparison, Course, SharedRankingCourse } from "@/types/database";

interface UserCourseWithCourse {
  course_id: string;
  courses: Course;
}

interface ProfileRow {
  username: string;
}

const SHARE_RATE_LIMIT = 10;
const SHARE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Rate limit: 10 per hour per user
  const limit = checkRateLimit(`share:${user.id}`, SHARE_RATE_LIMIT, SHARE_WINDOW_MS);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many shares. Try again later.", remaining: 0 },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)),
        },
      }
    );
  }

  // Fetch profile, courses, and comparisons in parallel
  const [profileRes, coursesRes, compsRes] = await Promise.all([
    supabase
      .from("profiles")
      .select("username")
      .eq("id", user.id)
      .single() as unknown as Promise<{ data: ProfileRow | null }>,
    supabase
      .from("user_courses")
      .select("course_id, courses(*)")
      .eq("user_id", user.id) as unknown as Promise<{
      data: UserCourseWithCourse[] | null;
    }>,
    supabase
      .from("comparisons")
      .select("*")
      .eq("user_id", user.id) as unknown as Promise<{
      data: Comparison[] | null;
    }>,
  ]);

  const profile = profileRes.data;
  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  const userCourses = coursesRes.data ?? [];
  const comparisons = compsRes.data ?? [];

  if (userCourses.length < 2 || comparisons.length === 0) {
    return NextResponse.json(
      { error: "You need at least 2 courses and 1 comparison to share rankings." },
      { status: 400 }
    );
  }

  // Compute rankings
  const courseIds = userCourses.map((uc) => uc.course_id);
  const courseMap = new Map<string, Course>();
  for (const uc of userCourses) {
    courseMap.set(uc.course_id, uc.courses);
  }

  const ranked = computeRankings(courseIds, comparisons);
  const confidence = overallConfidence(ranked);

  // Build the snapshot with denormalized course names
  const rankingsSnapshot: SharedRankingCourse[] = ranked
    .filter((entry) => entry.comparison_count > 0)
    .map((entry) => {
      const course = courseMap.get(entry.course_id);
      return {
        rank: entry.rank,
        course_name: course?.name ?? "Unknown Course",
        course_location: [course?.city, course?.state_province]
          .filter(Boolean)
          .join(", "),
        bt_score: entry.bt_score,
        confidence: entry.confidence,
      };
    });

  // Insert the shared ranking
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: shared, error } = await (supabase.from("shared_rankings") as any).insert({
    user_id: user.id,
    username: profile.username,
    rankings: rankingsSnapshot,
    confidence,
    course_count: userCourses.length,
    comparison_count: comparisons.length,
  }).select("id").single();

  if (error || !shared) {
    console.error("Failed to create shared ranking:", error);
    return NextResponse.json(
      { error: "Failed to create shared ranking" },
      { status: 500 }
    );
  }

  const sharePath = `/share/${shared.id}`;

  return NextResponse.json({
    id: shared.id,
    path: sharePath,
    remaining: limit.remaining,
  });
}
