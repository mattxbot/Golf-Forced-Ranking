"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/load-error";
import { ProfilePageSkeleton } from "@/components/skeleton";
import { useTheme } from "@/components/theme-provider";
import { computeRankings, overallConfidence } from "@/lib/ranking/bradley-terry";
import type { Course, Comparison } from "@/types/database";
import { Sun, Moon, Monitor, History } from "lucide-react";
import Link from "next/link";

export default function ProfilePage() {
  const [username, setUsername] = useState("");
  const [courseCount, setCourseCount] = useState(0);
  const [comparisonCount, setComparisonCount] = useState(0);
  const [confidence, setConfidence] = useState(0);
  const [topCourse, setTopCourse] = useState<Course | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const router = useRouter();
  const supabase = createClient();
  const { theme, setTheme } = useTheme();

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const profileRes = await (supabase.from("profiles") as any)
        .select("username").eq("id", user.id).single() as { data: { username: string } | null };
      const coursesRes = await supabase
        .from("user_courses")
        .select("course_id, courses(*)")
        .eq("user_id", user.id) as unknown as {
          data: { course_id: string; courses: Course }[] | null;
        };
      const compsRes = await supabase
        .from("comparisons")
        .select("*")
        .eq("user_id", user.id) as unknown as { data: Comparison[] | null };

      const userCourses = coursesRes.data ?? [];
      const comparisons = compsRes.data ?? [];

      setUsername(profileRes.data?.username ?? user.email ?? "");
      setCourseCount(userCourses.length);
      setComparisonCount(comparisons.length);

      // Compute rankings for confidence + top course
      if (userCourses.length >= 2 && comparisons.length > 0) {
        const courseIds = userCourses.map((uc) => uc.course_id);
        const rankings = computeRankings(courseIds, comparisons);
        setConfidence(overallConfidence(rankings));

        if (rankings.length > 0) {
          const topId = rankings[0].course_id;
          const topUc = userCourses.find((uc) => uc.course_id === topId);
          if (topUc) setTopCourse(topUc.courses);
        }
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  if (error) {
    return <LoadError onRetry={load} />;
  }

  if (loading) {
    return <ProfilePageSkeleton />;
  }

  return (
    <div className="px-4 pt-6">
      <h1 className="mb-6 text-xl font-semibold">Profile</h1>

      <div className="space-y-4">
        {/* User info */}
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground">Username</p>
          <p className="text-base font-semibold">{username}</p>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border bg-card p-3 text-center">
            <p className="text-2xl font-bold">{courseCount}</p>
            <p className="text-[11px] text-muted-foreground">Courses</p>
          </div>
          <div className="rounded-lg border bg-card p-3 text-center">
            <p className="text-2xl font-bold">{comparisonCount}</p>
            <p className="text-[11px] text-muted-foreground">Comparisons</p>
          </div>
          <div className="rounded-lg border bg-card p-3 text-center">
            <p className="text-2xl font-bold">{confidence}%</p>
            <p className="text-[11px] text-muted-foreground">Confidence</p>
          </div>
        </div>

        {/* Comparison History link */}
        <Link
          href="/history"
          className="flex items-center gap-3 rounded-lg border bg-card p-4 transition-colors hover:bg-accent"
        >
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
            <History className="h-4 w-4 text-primary" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold">Comparison History</p>
            <p className="text-xs text-muted-foreground">
              View your past decisions
            </p>
          </div>
          <svg
            className="h-4 w-4 text-muted-foreground"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M8.25 4.5l7.5 7.5-7.5 7.5"
            />
          </svg>
        </Link>

        {/* Top ranked course */}
        {topCourse && (
          <div className="rounded-lg border bg-card p-4">
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              #1 Ranked Course
            </p>
            <p className="text-base font-semibold">{topCourse.name}</p>
            <p className="text-xs text-muted-foreground">
              {[topCourse.city, topCourse.state_province].filter(Boolean).join(", ")}
            </p>
          </div>
        )}

        {/* Theme toggle */}
        <div className="rounded-lg border bg-card p-4">
          <p className="mb-3 text-xs font-medium text-muted-foreground">
            Appearance
          </p>
          <div className="flex gap-2">
            {([
              { value: "light" as const, icon: Sun, label: "Light" },
              { value: "dark" as const, icon: Moon, label: "Dark" },
              { value: "system" as const, icon: Monitor, label: "System" },
            ]).map(({ value, icon: Icon, label }) => (
              <button
                key={value}
                onClick={() => setTheme(value)}
                className={`flex flex-1 flex-col items-center gap-1.5 rounded-lg border p-2.5 text-xs transition-colors ${
                  theme === value
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-transparent bg-secondary text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>
        </div>

        <Button
          variant="outline"
          className="w-full"
          onClick={handleSignOut}
        >
          Sign out
        </Button>
      </div>
    </div>
  );
}
