"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { canonicalizePair } from "@/lib/utils";
import { computeRankings } from "@/lib/ranking/bradley-terry";
import { trackEvent } from "@/lib/events";
import { LoadError } from "@/components/load-error";
import type { Course, Comparison } from "@/types/database";

const SESSION_SIZE = 10;

export default function ComparePage() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [comparisons, setComparisons] = useState<Comparison[]>([]);
  const [pair, setPair] = useState<[Course, Course] | null>(null);
  const [sessionCount, setSessionCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);
  const comparisonStartRef = useRef<number>(0);

  // Refs to avoid stale closures in setTimeout callbacks
  const coursesRef = useRef<Course[]>([]);
  const comparisonsRef = useRef<Comparison[]>([]);
  const sessionCountRef = useRef(0);

  coursesRef.current = courses;
  comparisonsRef.current = comparisons;
  sessionCountRef.current = sessionCount;

  const router = useRouter();
  const supabase = createClient();

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      setUserId(user.id);

      const [coursesRes, compsRes] = await Promise.all([
        supabase
          .from("user_courses")
          .select("course_id, courses(*)")
          .eq("user_id", user.id) as unknown as Promise<{ data: { course_id: string; courses: Course }[] | null }>,
        supabase
          .from("comparisons")
          .select("*")
          .eq("user_id", user.id) as unknown as Promise<{ data: Comparison[] | null }>,
      ]);

      const userCourses = (coursesRes.data ?? []).map(
        (uc) => uc.courses
      );
      setCourses(userCourses);
      setComparisons(compsRes.data ?? []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  // Load data on mount
  useEffect(() => {
    loadData();
  }, [loadData]);

  // Select next pair using the Swiss-tournament algorithm.
  // Reads from refs so it always sees the latest state.
  const selectNextPair = useCallback((): [Course, Course] | null => {
    const currentCourses = coursesRef.current;
    const currentComparisons = comparisonsRef.current;
    const currentSessionCount = sessionCountRef.current;

    if (currentCourses.length < 2) return null;

    const compSet = new Set(
      currentComparisons.map((c) => `${c.course_a_id}:${c.course_b_id}`)
    );

    const compCountMap = new Map<string, number>();
    for (const course of currentCourses) {
      compCountMap.set(course.id, 0);
    }
    for (const comp of currentComparisons) {
      compCountMap.set(comp.course_a_id, (compCountMap.get(comp.course_a_id) ?? 0) + 1);
      compCountMap.set(comp.course_b_id, (compCountMap.get(comp.course_b_id) ?? 0) + 1);
    }

    function pairKey(a: string, b: string): string {
      return a < b ? `${a}:${b}` : `${b}:${a}`;
    }

    function isCompared(a: string, b: string): boolean {
      return compSet.has(pairKey(a, b));
    }

    // Phase A: Bootstrap — ensure every course has at least one comparison
    const uncompared = currentCourses.filter((c) => (compCountMap.get(c.id) ?? 0) === 0);
    if (uncompared.length > 0) {
      const target = uncompared[0];
      const others = currentCourses.filter((c) => c.id !== target.id);
      const partner = others[Math.floor(Math.random() * others.length)];
      return [target, partner];
    }

    // Compute rankings for informed pair selection
    const rankings = computeRankings(currentCourses.map((c) => c.id), currentComparisons);
    const sorted = [...rankings].sort((a, b) => b.bt_score - a.bt_score);

    // Phase B: Cross-rank exploration (every 5th comparison in session)
    if (currentSessionCount % 5 === 4 && sorted.length >= 8) {
      const topQ = sorted.slice(0, Math.ceil(sorted.length / 4));
      const bottomQ = sorted.slice(Math.floor(sorted.length * 0.75));
      const t = topQ[Math.floor(Math.random() * topQ.length)];
      const b = bottomQ[Math.floor(Math.random() * bottomQ.length)];
      if (!isCompared(t.course_id, b.course_id)) {
        const tc = currentCourses.find((c) => c.id === t.course_id)!;
        const bc = currentCourses.find((c) => c.id === b.course_id)!;
        return [tc, bc];
      }
    }

    // Phase C: Boundary refinement — adjacent uncompared pairs
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i].course_id;
      const b = sorted[i + 1].course_id;
      if (!isCompared(a, b)) {
        return [
          currentCourses.find((c) => c.id === a)!,
          currentCourses.find((c) => c.id === b)!,
        ];
      }
    }

    // Phase D: Confidence fill — lowest combined confidence uncompared pair
    let bestPair: [Course, Course] | null = null;
    let bestScore = Infinity;
    const rankMap = new Map(rankings.map((r) => [r.course_id, r]));

    for (let i = 0; i < currentCourses.length; i++) {
      for (let j = i + 1; j < currentCourses.length; j++) {
        if (!isCompared(currentCourses[i].id, currentCourses[j].id)) {
          const confA = rankMap.get(currentCourses[i].id)?.confidence ?? 0;
          const confB = rankMap.get(currentCourses[j].id)?.confidence ?? 0;
          const score = confA + confB;
          if (score < bestScore) {
            bestScore = score;
            bestPair = [currentCourses[i], currentCourses[j]];
          }
        }
      }
    }

    if (bestPair) return bestPair;

    // Phase E: Re-evaluation — all pairs compared, pick oldest
    const oldest = [...currentComparisons].sort(
      (a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
    )[0];
    if (oldest) {
      return [
        currentCourses.find((c) => c.id === oldest.course_a_id)!,
        currentCourses.find((c) => c.id === oldest.course_b_id)!,
      ].filter(Boolean) as [Course, Course];
    }

    return null;
  }, []);

  // Select initial pair after data loads
  useEffect(() => {
    if (!loading && courses.length >= 2 && !pair) {
      const nextPair = selectNextPair();
      if (nextPair) {
        setPair(nextPair);
        comparisonStartRef.current = Date.now();
      }
    }
  }, [loading, courses, pair, selectNextPair]);

  async function handleChoice(winnerId: string) {
    if (!pair || !userId || choosing) return;

    setChoosing(winnerId);

    const loserId = winnerId === pair[0].id ? pair[1].id : pair[0].id;
    const decidedInMs = Date.now() - comparisonStartRef.current;
    const canonical = canonicalizePair(winnerId, loserId);

    // Optimistic local update
    const newComparison: Comparison = {
      id: crypto.randomUUID(),
      user_id: userId,
      ...canonical,
      decided_in_ms: decidedInMs,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    setComparisons((prev) => {
      const filtered = prev.filter(
        (c) =>
          !(c.course_a_id === canonical.course_a_id &&
            c.course_b_id === canonical.course_b_id)
      );
      return [...filtered, newComparison];
    });

    const newSessionCount = sessionCount + 1;
    setSessionCount(newSessionCount);

    // Persist to DB (fire-and-forget)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase.from("comparisons") as any)
      .upsert(
        {
          user_id: userId,
          ...canonical,
          decided_in_ms: decidedInMs,
        },
        { onConflict: "user_id,course_a_id,course_b_id" }
      )
      .then();

    // Log implicit signal
    trackEvent(supabase, userId, "comparison_completed", {
      course_a_id: canonical.course_a_id,
      course_b_id: canonical.course_b_id,
      winner: canonical.winner,
      decided_in_ms: decidedInMs,
      session_index: newSessionCount,
    });

    // Persist ranking cache (debounced via session boundary)
    if (newSessionCount % 5 === 0 || newSessionCount >= SESSION_SIZE) {
      const allComps = [
        ...comparisons.filter(
          (c) =>
            !(c.course_a_id === canonical.course_a_id &&
              c.course_b_id === canonical.course_b_id)
        ),
        newComparison,
      ];
      const rankings = computeRankings(courses.map((c) => c.id), allComps);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabase.from("user_ranking_cache") as any)
        .upsert(
          {
            user_id: userId,
            rankings,
            is_stale: false,
            computed_at: new Date().toISOString(),
          },
          { onConflict: "user_id" }
        )
        .then();
    }

    // Check session completion
    if (newSessionCount >= SESSION_SIZE) {
      router.push("/rankings");
      return;
    }

    // Animate out then select next pair (refs ensure fresh data)
    setTimeout(() => {
      setChoosing(null);
      const nextPair = selectNextPair();
      if (nextPair) {
        setPair(nextPair);
        comparisonStartRef.current = Date.now();
      } else {
        router.push("/rankings");
      }
    }, 400);
  }

  if (error) {
    return <LoadError onRetry={loadData} />;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center pt-32">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading courses...</p>
        </div>
      </div>
    );
  }

  if (courses.length < 2) {
    return (
      <div className="flex flex-col items-center justify-center px-6 pt-24 text-center">
        <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-primary/10">
          <span className="text-4xl">&#9971;</span>
        </div>
        <h1 className="text-xl font-semibold">Need more courses</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Add at least 2 courses to start comparing.
        </p>
        <Button className="mt-6" onClick={() => router.push("/courses")}>
          Add courses
        </Button>
      </div>
    );
  }

  if (!pair) {
    return (
      <div className="flex items-center justify-center pt-32">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Finding courses to compare...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col px-4 pt-6">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Which do you prefer?</h1>
          <p className="text-xs text-muted-foreground">
            {sessionCount} of {SESSION_SIZE} this session
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/rankings")}
        >
          Done
        </Button>
      </div>

      {/* Progress bar */}
      <div className="mb-6 h-1.5 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300"
          style={{ width: `${(sessionCount / SESSION_SIZE) * 100}%` }}
        />
      </div>

      {/* Course cards */}
      <div className="relative space-y-3">
        {pair.map((course, idx) => (
          <div key={course.id}>
            <button
              onClick={() => handleChoice(course.id)}
              disabled={!!choosing}
              className={`w-full rounded-xl border-2 bg-card p-5 text-left shadow-sm transition-all duration-300 ${
                choosing === course.id
                  ? "scale-[1.02] border-primary shadow-md"
                  : choosing
                    ? "scale-[0.97] border-transparent opacity-50"
                    : "border-transparent active:scale-[0.98] active:border-primary hover:border-primary/50"
              }`}
            >
              <p className="text-base font-semibold">{course.name}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {[course.city, course.state_province].filter(Boolean).join(", ")}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {course.course_type && (
                  <span className="inline-block rounded-full bg-secondary px-2.5 py-0.5 text-xs capitalize">
                    {course.course_type}
                  </span>
                )}
                {course.architect && (
                  <span className="inline-block rounded-full bg-secondary px-2.5 py-0.5 text-xs text-muted-foreground">
                    {course.architect}
                  </span>
                )}
                {course.year_built && (
                  <span className="inline-block rounded-full bg-secondary px-2.5 py-0.5 text-xs text-muted-foreground">
                    Est. {course.year_built}
                  </span>
                )}
              </div>
              {(course.holes || course.par) && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {[
                    course.holes ? `${course.holes} holes` : null,
                    course.par ? `Par ${course.par}` : null,
                  ].filter(Boolean).join(" · ")}
                </p>
              )}
            </button>
            {/* VS divider between cards */}
            {idx === 0 && (
              <div className="relative flex items-center justify-center py-1">
                <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
                <span className="relative z-10 flex h-8 w-8 items-center justify-center rounded-full border bg-background text-xs font-bold text-muted-foreground">
                  VS
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
