"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { LoadError } from "@/components/load-error";
import { HistoryPageSkeleton } from "@/components/skeleton";
import { ArrowLeft, Clock, Trophy } from "lucide-react";
import Link from "next/link";

interface CourseInfo {
  id: string;
  name: string;
  city: string | null;
  state_province: string | null;
}

interface ComparisonWithCourses {
  id: string;
  user_id: string;
  course_a_id: string;
  course_b_id: string;
  winner: "a" | "b";
  decided_in_ms: number | null;
  created_at: string;
  updated_at: string;
  course_a: CourseInfo;
  course_b: CourseInfo;
}

interface DateGroup {
  label: string;
  comparisons: ComparisonWithCourses[];
}

function getRelativeTime(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 1) return "1d ago";
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function groupByDate(comparisons: ComparisonWithCourses[]): DateGroup[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);

  const groups: Record<string, ComparisonWithCourses[]> = {
    Today: [],
    Yesterday: [],
    "This Week": [],
    Earlier: [],
  };

  for (const comp of comparisons) {
    const date = new Date(comp.created_at);
    if (date >= today) {
      groups["Today"].push(comp);
    } else if (date >= yesterday) {
      groups["Yesterday"].push(comp);
    } else if (date >= weekAgo) {
      groups["This Week"].push(comp);
    } else {
      groups["Earlier"].push(comp);
    }
  }

  return Object.entries(groups)
    .filter(([, comps]) => comps.length > 0)
    .map(([label, comparisons]) => ({ label, comparisons }));
}

function formatDecisionTime(ms: number | null): string | null {
  if (ms === null) return null;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function HistoryPage() {
  const [comparisons, setComparisons] = useState<ComparisonWithCourses[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const supabase = createClient();

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      const { data } = await supabase
        .from("comparisons")
        .select(
          "*, course_a:courses!course_a_id(id, name, city, state_province), course_b:courses!course_b_id(id, name, city, state_province)"
        )
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(100);

      setComparisons((data as unknown as ComparisonWithCourses[]) ?? []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return <LoadError onRetry={load} />;
  }

  if (loading) {
    return <HistoryPageSkeleton />;
  }

  const groups = groupByDate(comparisons);

  return (
    <div className="px-4 pt-6 pb-8">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <Link
          href="/profile"
          className="flex h-8 w-8 items-center justify-center rounded-lg border bg-card text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-xl font-semibold">Comparison History</h1>
          <p className="text-xs text-muted-foreground">
            {comparisons.length} comparison{comparisons.length !== 1 ? "s" : ""}{" "}
            total
          </p>
        </div>
      </div>

      {/* Empty state */}
      {comparisons.length === 0 && (
        <div className="flex flex-col items-center justify-center pt-20 text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
            <Trophy className="h-6 w-6 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium">No comparisons yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Start comparing courses to build your history.
          </p>
        </div>
      )}

      {/* Timeline */}
      <div className="space-y-6">
        {groups.map((group) => (
          <div key={group.label}>
            {/* Date group header */}
            <div className="mb-3 flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {group.label}
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>

            {/* Timeline entries */}
            <div className="relative ml-3">
              {/* Vertical connector line */}
              <div className="absolute left-0 top-2 bottom-2 w-px bg-border" />

              <div className="space-y-3">
                {group.comparisons.map((comp) => {
                  const winner =
                    comp.winner === "a" ? comp.course_a : comp.course_b;
                  const loser =
                    comp.winner === "a" ? comp.course_b : comp.course_a;
                  const decisionTime = formatDecisionTime(comp.decided_in_ms);

                  return (
                    <div key={comp.id} className="relative flex gap-3 pl-5">
                      {/* Timeline dot */}
                      <div className="absolute left-[-3px] top-2 h-[7px] w-[7px] rounded-full border-2 border-primary bg-background" />

                      {/* Entry content */}
                      <div className="min-w-0 flex-1 rounded-lg border bg-card p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold">
                              {winner.name}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              over
                            </p>
                            <p className="truncate text-sm text-muted-foreground">
                              {loser.name}
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            {decisionTime && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                <Clock className="h-2.5 w-2.5" />
                                {decisionTime}
                              </span>
                            )}
                            <span className="text-[10px] text-muted-foreground">
                              {getRelativeTime(comp.created_at)}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
