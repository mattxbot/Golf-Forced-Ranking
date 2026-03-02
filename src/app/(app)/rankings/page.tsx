"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { computeRankings, overallConfidence } from "@/lib/ranking/bradley-terry";
import type { Course, Comparison, RankingEntry } from "@/types/database";

interface UserCourseWithCourse {
  id: string;
  course_id: string;
  courses: Course;
}

export default function RankingsPage() {
  const [courses, setCourses] = useState<Map<string, Course>>(new Map());
  const [rankings, setRankings] = useState<RankingEntry[]>([]);
  const [courseCount, setCourseCount] = useState(0);
  const [comparisonCount, setComparisonCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const [coursesRes, compsRes] = await Promise.all([
        supabase
          .from("user_courses")
          .select("id, course_id, courses(*)")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false }) as unknown as Promise<{ data: UserCourseWithCourse[] | null }>,
        supabase
          .from("comparisons")
          .select("*")
          .eq("user_id", user.id) as unknown as Promise<{ data: Comparison[] | null }>,
      ]);

      const userCourses = coursesRes.data ?? [];
      const comparisons = compsRes.data ?? [];

      const courseMap = new Map<string, Course>();
      for (const uc of userCourses) {
        courseMap.set(uc.course_id, uc.courses);
      }

      setCourses(courseMap);
      setCourseCount(userCourses.length);
      setComparisonCount(comparisons.length);

      if (userCourses.length >= 2 && comparisons.length > 0) {
        const courseIds = userCourses.map((uc) => uc.course_id);
        const computed = computeRankings(courseIds, comparisons);
        setRankings(computed);
      }

      setLoading(false);
    }
    load();
  }, [supabase]);

  if (loading) {
    return (
      <div className="flex items-center justify-center pt-32">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading rankings...</p>
        </div>
      </div>
    );
  }

  // Empty state: no courses added yet
  if (courseCount === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-6 pt-24 text-center">
        <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-primary/10">
          <span className="text-4xl">&#9971;</span>
        </div>
        <h1 className="text-xl font-semibold">No courses yet</h1>
        <p className="mt-2 max-w-[250px] text-sm text-muted-foreground">
          Add golf courses you&apos;ve played to start building your personal ranking.
        </p>
        <Link href="/courses">
          <Button className="mt-6">Add your first course</Button>
        </Link>
      </div>
    );
  }

  // Needs more courses to compare
  if (courseCount < 2) {
    return (
      <div className="flex flex-col items-center justify-center px-6 pt-24 text-center">
        <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-primary/10">
          <span className="text-4xl">&#9971;</span>
        </div>
        <h1 className="text-xl font-semibold">Add one more course</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You need at least 2 courses to start comparing.
        </p>
        <Link href="/courses">
          <Button className="mt-6">Add courses</Button>
        </Link>
      </div>
    );
  }

  // Has courses but no comparisons
  if (comparisonCount === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-6 pt-24 text-center">
        <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-primary/10">
          <span className="text-4xl">&#127942;</span>
        </div>
        <h1 className="text-xl font-semibold">Ready to rank</h1>
        <p className="mt-2 max-w-[250px] text-sm text-muted-foreground">
          You&apos;ve added {courseCount} courses. Start comparing them to build your ranking.
        </p>
        <Link href="/compare">
          <Button className="mt-6">Start comparing</Button>
        </Link>
      </div>
    );
  }

  // Has rankings — show ranked list with BT scores
  const confidence = overallConfidence(rankings);

  return (
    <div className="px-4 pt-6">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">My Rankings</h1>
          <p className="text-xs text-muted-foreground">
            {courseCount} courses &middot; {comparisonCount} comparisons
          </p>
        </div>
        <Button size="sm" onClick={() => router.push("/compare")}>
          Compare
        </Button>
      </div>

      {/* Confidence meter */}
      <div className="mb-5 rounded-lg border bg-card p-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">
            Ranking confidence
          </span>
          <span className="text-xs font-semibold">{confidence}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${confidence}%` }}
          />
        </div>
        {confidence < 50 && (
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Keep comparing to improve accuracy
          </p>
        )}
      </div>

      {/* Ranked list */}
      <div className="space-y-2">
        {rankings.map((entry) => {
          const course = courses.get(entry.course_id);
          if (!course) return null;

          return (
            <div
              key={entry.course_id}
              className="flex items-center gap-3 rounded-lg border bg-card p-3 transition-colors"
            >
              {/* Rank badge */}
              <div className="flex flex-col items-center">
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                    entry.rank === 1
                      ? "bg-yellow-100 text-yellow-700"
                      : entry.rank === 2
                        ? "bg-gray-100 text-gray-600"
                        : entry.rank === 3
                          ? "bg-orange-100 text-orange-700"
                          : "bg-primary/10 text-primary"
                  }`}
                >
                  {entry.rank}
                </span>
              </div>

              {/* Course info */}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {course.name}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {[course.city, course.state_province].filter(Boolean).join(", ")}
                </p>
              </div>

              {/* Score + confidence */}
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span className="text-sm font-semibold tabular-nums">
                  {entry.bt_score.toFixed(1)}
                </span>
                <div className="flex items-center gap-1">
                  <div className="h-1 w-10 overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-primary/60 transition-all"
                      style={{ width: `${entry.confidence * 100}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
