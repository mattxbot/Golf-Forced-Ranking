"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trackEvent } from "@/lib/events";
import { LoadError } from "@/components/load-error";
import type { Course } from "@/types/database";

export default function CoursesPage() {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Course[]>([]);
  const [myCourses, setMyCourses] = useState<(Course & { user_course_id: string })[]>([]);
  const [myCourseIds, setMyCourseIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [initLoading, setInitLoading] = useState(true);
  const [initError, setInitError] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const supabase = createClient();

  const loadMyCourses = useCallback(async () => {
    setInitLoading(true);
    setInitError(false);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data } = await supabase
        .from("user_courses")
        .select("id, course_id, courses(*)")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false }) as unknown as {
          data: { id: string; course_id: string; courses: Course }[] | null;
        };

      if (data) {
        const courses = data.map((uc) => ({
          ...uc.courses,
          user_course_id: uc.id,
        }));
        setMyCourses(courses);
        setMyCourseIds(new Set(data.map((uc) => uc.course_id)));
      }
    } catch {
      setInitError(true);
    } finally {
      setInitLoading(false);
    }
  }, [supabase]);

  // Load user's courses on mount
  useEffect(() => {
    loadMyCourses();
  }, [loadMyCourses]);

  // Search courses
  const searchCourses = useCallback(async (query: string) => {
    if (query.length < 2) {
      setResults([]);
      return;
    }
    setLoading(true);
    const { data } = await supabase
      .from("courses")
      .select("*")
      .ilike("name", `%${query}%`)
      .order("name")
      .limit(20);

    setResults(data ?? []);
    setLoading(false);
  }, [supabase]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => searchCourses(search), 300);
    return () => clearTimeout(timer);
  }, [search, searchCourses]);

  async function addCourse(courseId: string) {
    setAdding(courseId);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    // Log event (RecSys implicit signal)
    trackEvent(supabase, user.id, "course_add", { course_id: courseId });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase.from("user_courses") as any)
      .insert({ user_id: user.id, course_id: courseId })
      .select("id, course_id, courses(*)")
      .single() as {
        data: { id: string; course_id: string; courses: Course } | null;
      };

    if (data) {
      const course = {
        ...data.courses,
        user_course_id: data.id,
      };
      setMyCourses((prev) => [course, ...prev]);
      setMyCourseIds((prev) => new Set([...prev, courseId]));
    }
    setAdding(null);
  }

  async function removeCourse(userCourseId: string, courseId: string) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    trackEvent(supabase, user.id, "course_remove", { course_id: courseId });

    await supabase.from("user_courses").delete().eq("id", userCourseId);
    setMyCourses((prev) => prev.filter((c) => c.user_course_id !== userCourseId));
    setMyCourseIds((prev) => {
      const next = new Set(prev);
      next.delete(courseId);
      return next;
    });
  }

  if (initError) {
    return <LoadError onRetry={loadMyCourses} />;
  }

  if (initLoading) {
    return (
      <div className="flex items-center justify-center pt-32">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading courses...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 pt-6">
      <h1 className="mb-4 text-xl font-semibold">My Courses</h1>

      {/* Search */}
      <div className="mb-6">
        <Input
          type="search"
          placeholder="Search golf courses..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full"
        />

        {/* Search results */}
        {search.length >= 2 && (
          <div className="mt-2 rounded-lg border">
            {loading ? (
              <p className="p-3 text-sm text-muted-foreground">Searching...</p>
            ) : results.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">
                No courses found for &quot;{search}&quot;
              </p>
            ) : (
              <ul className="divide-y">
                {results.map((course) => (
                  <li key={course.id} className="flex items-center justify-between p-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{course.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {[course.city, course.state_province].filter(Boolean).join(", ")}
                      </p>
                    </div>
                    {myCourseIds.has(course.id) ? (
                      <span className="shrink-0 text-xs text-muted-foreground">Added</span>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => addCourse(course.id)}
                        disabled={adding === course.id}
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

      {/* My courses list */}
      {myCourses.length === 0 ? (
        <p className="text-center text-sm text-muted-foreground">
          Search above to add courses you&apos;ve played.
        </p>
      ) : (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">
            {myCourses.length} course{myCourses.length !== 1 ? "s" : ""} played
          </p>
          {myCourses.map((course) => (
            <div
              key={course.user_course_id}
              className="flex items-center justify-between rounded-lg border p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{course.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {[course.city, course.state_province].filter(Boolean).join(", ")}
                  {course.course_type && ` · ${course.course_type}`}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => removeCourse(course.user_course_id, course.id)}
                className="shrink-0 text-muted-foreground hover:text-destructive"
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
