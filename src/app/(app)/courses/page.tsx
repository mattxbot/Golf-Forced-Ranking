"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trackEvent } from "@/lib/events";
import { searchQuerySchema, courseCreateSchema } from "@/lib/validation";
import { slugify } from "@/lib/utils";
import { LoadError } from "@/components/load-error";
import { CoursesPageSkeleton } from "@/components/skeleton";
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
  const [userId, setUserId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState({
    name: "", city: "", state_province: "", course_type: "", holes: "", par: "",
  });
  const supabase = createClient();

  const loadMyCourses = useCallback(async () => {
    setInitLoading(true);
    setInitError(false);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      setUserId(user.id);

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

  // Search courses with validated input
  const searchCourses = useCallback(async (query: string) => {
    const parsed = searchQuerySchema.safeParse(query);
    if (!parsed.success) {
      setResults([]);
      return;
    }
    setLoading(true);
    const { data } = await supabase
      .from("courses")
      .select("id, name, slug, city, state_province, course_type, architect, year_built, holes, par")
      .ilike("name", `%${parsed.data}%`)
      .order("name")
      .limit(20);

    const resultList = data ?? [];
    setResults(resultList);
    setLoading(false);

    // Track search signal for recommendation quality
    if (userId) {
      trackEvent(supabase, userId, "search_query", {
        query: parsed.data,
        result_count: resultList.length,
      });
    }
  }, [supabase, userId]);

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

    // Delete user_course and orphaned comparisons in parallel
    await Promise.all([
      supabase.from("user_courses").delete().eq("id", userCourseId),
      supabase
        .from("comparisons")
        .delete()
        .eq("user_id", user.id)
        .or(`course_a_id.eq.${courseId},course_b_id.eq.${courseId}`),
    ]);

    // Mark ranking cache stale
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase.from("user_ranking_cache") as any)
      .update({ is_stale: true })
      .eq("user_id", user.id)
      .then();

    setMyCourses((prev) => prev.filter((c) => c.user_course_id !== userCourseId));
    setMyCourseIds((prev) => {
      const next = new Set(prev);
      next.delete(courseId);
      return next;
    });
  }

  async function createCourse() {
    if (!userId) return;
    setCreateError(null);

    const parsed = courseCreateSchema.safeParse({
      ...createForm,
      holes: createForm.holes || undefined,
      par: createForm.par || undefined,
      course_type: createForm.course_type || undefined,
    });
    if (!parsed.success) {
      setCreateError(parsed.error.issues[0].message);
      return;
    }

    setCreating(true);
    const slug = slugify(parsed.data.name, parsed.data.city, parsed.data.state_province);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: course, error } = await (supabase.from("courses") as any)
      .insert({
        name: parsed.data.name,
        slug,
        city: parsed.data.city || null,
        state_province: parsed.data.state_province || null,
        course_type: parsed.data.course_type || null,
        holes: parsed.data.holes || 18,
        par: parsed.data.par || null,
        created_by: userId,
      })
      .select("*")
      .single() as { data: Course | null; error: unknown };

    if (error || !course) {
      setCreateError("Failed to create course. It may already exist.");
      setCreating(false);
      return;
    }

    // Auto-add to user's courses
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: uc } = await (supabase.from("user_courses") as any)
      .insert({ user_id: userId, course_id: course.id })
      .select("id")
      .single() as { data: { id: string } | null };

    if (uc) {
      setMyCourses((prev) => [{ ...course, user_course_id: uc.id }, ...prev]);
      setMyCourseIds((prev) => new Set([...prev, course.id]));
    }

    trackEvent(supabase, userId, "course_add", {
      course_id: course.id,
      created: true,
    });

    setCreating(false);
    setShowCreate(false);
    setCreateForm({ name: "", city: "", state_province: "", course_type: "", holes: "", par: "" });
    setSearch("");
  }

  if (initError) {
    return <LoadError onRetry={loadMyCourses} />;
  }

  if (initLoading) {
    return <CoursesPageSkeleton />;
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
              <div className="p-3">
                <p className="text-sm text-muted-foreground">
                  No courses found for &quot;{search}&quot;
                </p>
                <button
                  className="mt-2 text-sm font-medium text-primary"
                  onClick={() => {
                    setShowCreate(true);
                    setCreateForm((f) => ({ ...f, name: search }));
                  }}
                >
                  + Add &quot;{search}&quot; as a new course
                </button>
              </div>
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

      {/* Create course form */}
      {showCreate && (
        <div className="mb-6 rounded-lg border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Add a new course</h2>
            <button
              className="text-xs text-muted-foreground"
              onClick={() => setShowCreate(false)}
            >
              Cancel
            </button>
          </div>
          <div className="space-y-3">
            <Input
              placeholder="Course name *"
              value={createForm.name}
              onChange={(e) =>
                setCreateForm((f) => ({ ...f, name: e.target.value }))
              }
            />
            <div className="flex gap-2">
              <Input
                placeholder="City"
                value={createForm.city}
                onChange={(e) =>
                  setCreateForm((f) => ({ ...f, city: e.target.value }))
                }
                className="flex-1"
              />
              <Input
                placeholder="State"
                value={createForm.state_province}
                onChange={(e) =>
                  setCreateForm((f) => ({ ...f, state_province: e.target.value }))
                }
                className="flex-1"
              />
            </div>
            <div className="flex gap-2">
              <select
                value={createForm.course_type}
                onChange={(e) =>
                  setCreateForm((f) => ({ ...f, course_type: e.target.value }))
                }
                className="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
              >
                <option value="">Type (optional)</option>
                <option value="links">Links</option>
                <option value="parkland">Parkland</option>
                <option value="desert">Desert</option>
                <option value="mountain">Mountain</option>
                <option value="resort">Resort</option>
                <option value="municipal">Municipal</option>
                <option value="private">Private</option>
              </select>
              <Input
                type="number"
                placeholder="Holes"
                value={createForm.holes}
                onChange={(e) =>
                  setCreateForm((f) => ({ ...f, holes: e.target.value }))
                }
                className="w-20"
              />
              <Input
                type="number"
                placeholder="Par"
                value={createForm.par}
                onChange={(e) =>
                  setCreateForm((f) => ({ ...f, par: e.target.value }))
                }
                className="w-20"
              />
            </div>
            {createError && (
              <p className="text-xs text-destructive">{createError}</p>
            )}
            <Button
              className="w-full"
              onClick={createCourse}
              disabled={creating}
            >
              {creating ? "Creating..." : "Create & add to my courses"}
            </Button>
          </div>
        </div>
      )}

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
