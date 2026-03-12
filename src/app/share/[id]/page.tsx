/**
 * Public share page — displays a read-only snapshot of a user's golf rankings.
 * Server component. No authentication required.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import type { SharedRanking } from "@/types/database";
import type { Metadata } from "next";

interface SharePageProps {
  params: Promise<{ id: string }>;
}

async function getSharedRanking(id: string): Promise<SharedRanking | null> {
  const supabase = await createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase.from("shared_rankings") as any)
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) return null;
  return data as SharedRanking;
}

export async function generateMetadata({
  params,
}: SharePageProps): Promise<Metadata> {
  const { id } = await params;
  const shared = await getSharedRanking(id);

  if (!shared) {
    return { title: "Rankings Not Found — Fairway" };
  }

  return {
    title: `${shared.username}'s Golf Rankings — Fairway`,
    description: `Check out ${shared.username}'s top ${shared.course_count} golf courses ranked on Fairway.`,
  };
}

export default async function SharePage({ params }: SharePageProps) {
  const { id } = await params;
  const shared = await getSharedRanking(id);

  if (!shared) {
    notFound();
  }

  const createdDate = new Date(shared.created_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="mx-auto min-h-screen max-w-lg bg-background">
      {/* Header / branding */}
      <div className="border-b px-4 py-4">
        <Link href="/" className="text-lg font-bold tracking-tight text-primary">
          Fairway
        </Link>
      </div>

      <div className="px-4 pt-6 pb-12">
        {/* Sharer info */}
        <div className="mb-4">
          <h1 className="text-xl font-semibold">
            {shared.username}&apos;s Rankings
          </h1>
          <p className="text-xs text-muted-foreground">
            {shared.course_count} courses &middot;{" "}
            {shared.comparison_count} comparisons &middot; {createdDate}
          </p>
        </div>

        {/* Confidence meter */}
        <div className="mb-5 rounded-lg border bg-card p-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              Ranking confidence
            </span>
            <span className="text-xs font-semibold">{shared.confidence}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{ width: `${shared.confidence}%` }}
            />
          </div>
        </div>

        {/* Ranked list */}
        <div className="space-y-2">
          {shared.rankings.map((entry, i) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded-lg border bg-card p-3"
            >
              {/* Rank badge */}
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                  entry.rank === 1
                    ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-400"
                    : entry.rank === 2
                      ? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                      : entry.rank === 3
                        ? "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400"
                        : "bg-primary/10 text-primary"
                }`}
              >
                {entry.rank}
              </span>

              {/* Course info */}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {entry.course_name}
                </p>
                {entry.course_location && (
                  <p className="truncate text-xs text-muted-foreground">
                    {entry.course_location}
                  </p>
                )}
              </div>

              {/* Score */}
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
          ))}
        </div>

        {/* CTA */}
        <div className="mt-8 rounded-lg border border-dashed border-primary/30 bg-primary/5 p-4 text-center">
          <p className="text-sm font-medium">
            Want to rank your own golf courses?
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Create your personal golf course rankings with Fairway.
          </p>
          <Link href="/signup">
            <Button className="mt-3" size="sm">
              Create your own rankings
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
