"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { canonicalizePair } from "@/lib/utils";
import { computeRankings, ALGORITHM_VERSION } from "@/lib/ranking/bradley-terry";
import { trackEvent } from "@/lib/events";
import { searchQuerySchema } from "@/lib/validation";
import type { Course, Comparison } from "@/types/database";

const MIN_COURSES = 3;
const QUICK_COMPARE_ROUNDS = 3;

type Step = "add-courses" | "quick-compare" | "first-ranking";

export default function OnboardingPage() {
  const [step, setStep] = useState<Step>("add-courses");
  const [userId, setUserId] = useState<string | null>(null);

  // Course picker state
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Course[]>([]);
  const [searching, setSearching] = useState(false);
  const [addedCourses, setAddedCourses] = useState<Course[]>([]);
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<string | null>(null);

  // Compare state
  const [pair, setPair] = useState<[Course, Course] | null>(null);
  const [compareRound, setCompareRound] = useState(0);
  const [comparisons, setComparisons] = useState<Comparison[]>([]);
  const [choosing, setChoosing] = useState<string | null>(null);

  const router = useRouter();
  const supabase = createClient();

  // Check auth and existing courses
  useEffect(() => {
    async function init() {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.replace("/login");
        return;
      }
      setUserId(user.id);

      // If user already has courses, skip onboarding
      const { count } = await supabase
        .from("user_courses")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user.id);

      if (count && count >= MIN_COURSES) {
        router.replace("/rankings");
      }
    }
    init();
  }, [supabase, router]);

  // Debounced search
  const searchCourses = useCallback(
    async (query: string) => {
      const parsed = searchQuerySchema.safeParse(query);
      if (!parsed.success) {
        setResults([]);
        return;
      }
      setSearching(true);
      const { data } = await supabase
        .from("courses")
        .select("id, name, slug, city, state_province, course_type, architect, year_built, holes, par")
        .ilike("name", `%${parsed.data}%`)
        .order("name")
        .limit(15);
      setResults(data ?? []);
      setSearching(false);
    },
    [supabase]
  );

  useEffect(() => {
    const timer = setTimeout(() => searchCourses(search), 300);
    return () => clearTimeout(timer);
  }, [search, searchCourses]);

  async function addCourse(course: Course) {
    if (!userId) return;
    setAdding(course.id);

    trackEvent(supabase, userId, "course_add", { course_id: course.id });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase.from("user_courses") as any)
      .insert({ user_id: userId, course_id: course.id })
      .select("id")
      .single();

    setAddedCourses((prev) => [...prev, course]);
    setAddedIds((prev) => new Set([...prev, course.id]));
    setAdding(null);
    setSearch("");
    setResults([]);
  }

  function startQuickCompare() {
    if (addedCourses.length < MIN_COURSES) return;
    // Pick first pair: course 0 vs course 1
    setPair([addedCourses[0], addedCourses[1]]);
    setCompareRound(0);
    setStep("quick-compare");
  }

  function getNextPair(round: number): [Course, Course] | null {
    const c = addedCourses;
    // Ensure we compare different pairs
    if (round === 0 && c.length >= 2) return [c[0], c[1]];
    if (round === 1 && c.length >= 3) return [c[0], c[2]];
    if (round === 2 && c.length >= 3) return [c[1], c[2]];
    // For more courses, pick next uncompared pair
    if (round < QUICK_COMPARE_ROUNDS) {
      const idx = round + 1;
      return [c[idx % c.length], c[(idx + 1) % c.length]];
    }
    return null;
  }

  async function handleCompare(winnerId: string) {
    if (!pair || !userId || choosing) return;
    setChoosing(winnerId);

    const loserId = winnerId === pair[0].id ? pair[1].id : pair[0].id;
    const canonical = canonicalizePair(winnerId, loserId);

    const newComparison: Comparison = {
      id: crypto.randomUUID(),
      user_id: userId,
      ...canonical,
      decided_in_ms: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    setComparisons((prev) => [...prev, newComparison]);

    // Persist to DB
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase.from("comparisons") as any)
      .upsert(
        {
          user_id: userId,
          ...canonical,
        },
        { onConflict: "user_id,course_a_id,course_b_id" }
      )
      .then();

    trackEvent(supabase, userId, "comparison_completed", {
      ...canonical,
      onboarding: true,
      round: compareRound,
    });

    const nextRound = compareRound + 1;

    setTimeout(() => {
      setChoosing(null);
      if (nextRound >= QUICK_COMPARE_ROUNDS) {
        // Compute and cache ranking
        const allComps = [...comparisons, newComparison];
        const courseIds = addedCourses.map((c) => c.id);
        const rankings = computeRankings(courseIds, allComps);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase.from("user_ranking_cache") as any)
          .upsert(
            {
              user_id: userId,
              rankings,
              is_stale: false,
              algorithm_version: ALGORITHM_VERSION,
              computed_at: new Date().toISOString(),
            },
            { onConflict: "user_id" }
          )
          .then();

        setStep("first-ranking");
      } else {
        setCompareRound(nextRound);
        const nextPair = getNextPair(nextRound);
        if (nextPair) setPair(nextPair);
        else setStep("first-ranking");
      }
    }, 350);
  }

  // ---------------------------------------------------------------------------
  // Step 1: Add courses
  // ---------------------------------------------------------------------------
  if (step === "add-courses") {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col px-4 pt-12">
        {/* Header */}
        <div className="mb-2 text-center">
          <span className="text-4xl">&#9971;</span>
        </div>
        <h1 className="text-center text-xl font-semibold">
          Courses you&apos;ve played
        </h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">
          Add at least {MIN_COURSES} courses to get started
        </p>

        {/* Search */}
        <div className="mt-6">
          <Input
            type="search"
            placeholder="Search golf courses..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />

          {search.length >= 2 && (
            <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border">
              {searching ? (
                <p className="p-3 text-sm text-muted-foreground">
                  Searching...
                </p>
              ) : results.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">
                  No courses found
                </p>
              ) : (
                <ul className="divide-y">
                  {results.map((course) => (
                    <li
                      key={course.id}
                      className="flex items-center justify-between p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {course.name}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {[course.city, course.state_province]
                            .filter(Boolean)
                            .join(", ")}
                        </p>
                      </div>
                      {addedIds.has(course.id) ? (
                        <span className="shrink-0 text-xs text-green-600">
                          Added
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={adding === course.id}
                          onClick={() => addCourse(course)}
                          className="shrink-0"
                        >
                          {adding === course.id ? "..." : "Add"}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Added courses */}
        {addedCourses.length > 0 && (
          <div className="mt-6 space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              {addedCourses.length} of {MIN_COURSES}+ courses added
            </p>
            {addedCourses.map((course) => (
              <div
                key={course.id}
                className="flex items-center gap-2 rounded-lg border bg-card p-3"
              >
                <span className="text-green-500 text-sm">&#10003;</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{course.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[course.city, course.state_province]
                      .filter(Boolean)
                      .join(", ")}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Continue button */}
        <div className="mt-auto pb-8 pt-6">
          <Button
            className="w-full"
            disabled={addedCourses.length < MIN_COURSES}
            onClick={startQuickCompare}
          >
            {addedCourses.length < MIN_COURSES
              ? `Add ${MIN_COURSES - addedCourses.length} more course${MIN_COURSES - addedCourses.length !== 1 ? "s" : ""}`
              : "Next: Quick rank"}
          </Button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Step 2: Quick compare
  // ---------------------------------------------------------------------------
  if (step === "quick-compare" && pair) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col px-4 pt-12">
        <div className="mb-2 text-center">
          <span className="text-4xl">&#129351;</span>
        </div>
        <h1 className="text-center text-xl font-semibold">
          Quick rank
        </h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">
          Pick the course you prefer ({compareRound + 1} of{" "}
          {QUICK_COMPARE_ROUNDS})
        </p>

        {/* Progress */}
        <div className="mx-auto mt-4 h-1.5 w-48 overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full bg-primary transition-all duration-300"
            style={{
              width: `${((compareRound + 1) / QUICK_COMPARE_ROUNDS) * 100}%`,
            }}
          />
        </div>

        {/* Course cards */}
        <div className="mt-8 space-y-3">
          {pair.map((course, idx) => (
            <div key={course.id}>
              <button
                onClick={() => handleCompare(course.id)}
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
                  {[course.city, course.state_province]
                    .filter(Boolean)
                    .join(", ")}
                </p>
              </button>
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

  // ---------------------------------------------------------------------------
  // Step 3: First ranking reveal
  // ---------------------------------------------------------------------------
  if (step === "first-ranking") {
    const courseIds = addedCourses.map((c) => c.id);
    const rankings = computeRankings(courseIds, comparisons);
    const courseMap = new Map(addedCourses.map((c) => [c.id, c]));

    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col px-4 pt-12">
        <div className="mb-2 text-center">
          <span className="text-4xl">&#127942;</span>
        </div>
        <h1 className="text-center text-xl font-semibold">
          Your first ranking
        </h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">
          Keep comparing to refine your list
        </p>

        <div className="mt-8 space-y-2">
          {rankings.map((entry) => {
            const course = courseMap.get(entry.course_id);
            if (!course) return null;
            return (
              <div
                key={entry.course_id}
                className="flex items-center gap-3 rounded-lg border bg-card p-3"
              >
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
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{course.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[course.city, course.state_province]
                      .filter(Boolean)
                      .join(", ")}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-auto pb-8 pt-6">
          <Button className="w-full" onClick={() => router.replace("/rankings")}>
            View full rankings
          </Button>
        </div>
      </div>
    );
  }

  // Fallback loading
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}
