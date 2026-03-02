import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import type { Course } from "@/types/database";

interface UserCourseWithCourse {
  id: string;
  course_id: string;
  courses: Course;
}

export default async function RankingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Load user's courses to determine state
  const { data: userCourses } = await supabase
    .from("user_courses")
    .select("id, course_id, courses(*)")
    .eq("user_id", user!.id)
    .order("created_at", { ascending: false }) as unknown as { data: UserCourseWithCourse[] | null };

  // Load comparisons count
  const { count: comparisonCount } = await supabase
    .from("comparisons")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user!.id);

  const courseCount = userCourses?.length ?? 0;
  const comparisons = comparisonCount ?? 0;

  // Empty state: no courses added yet
  if (courseCount === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-6 pt-24 text-center">
        <div className="mb-2 text-5xl">&#9971;</div>
        <h1 className="text-xl font-semibold">No courses yet</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Add golf courses you&apos;ve played to start building your ranking.
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
  if (comparisons === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-6 pt-24 text-center">
        <h1 className="text-xl font-semibold">Ready to rank</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You&apos;ve added {courseCount} courses. Start comparing them to build your ranking.
        </p>
        <Link href="/compare">
          <Button className="mt-6">Start comparing</Button>
        </Link>
      </div>
    );
  }

  // Has rankings — show ranked list
  // For now: show courses ordered by creation (ranking display is Milestone 4)
  return (
    <div className="px-4 pt-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">My Rankings</h1>
          <p className="text-xs text-muted-foreground">
            {courseCount} courses &middot; {comparisons} comparisons
          </p>
        </div>
        <Link href="/compare">
          <Button size="sm">Compare</Button>
        </Link>
      </div>

      <div className="space-y-2">
        {userCourses?.map((uc, index) => {
          const course = uc.courses;
          return (
            <div
              key={uc.id}
              className="flex items-center gap-3 rounded-lg border p-3"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {course.name}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {[course.city, course.state_province].filter(Boolean).join(", ")}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
