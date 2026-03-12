import { cn } from "@/lib/utils";

export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-secondary", className)}
      {...props}
    />
  );
}

/** Skeleton for a ranked course card */
export function RankingSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
      <Skeleton className="h-8 w-8 rounded-full" />
      <div className="flex-1 space-y-1.5">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <Skeleton className="h-4 w-10" />
    </div>
  );
}

/** Skeleton for the rankings page */
export function RankingsPageSkeleton() {
  return (
    <div className="px-4 pt-6">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="space-y-1.5">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-3 w-40" />
        </div>
        <Skeleton className="h-9 w-20 rounded-md" />
      </div>
      {/* Confidence meter */}
      <Skeleton className="mb-5 h-16 rounded-lg" />
      {/* Ranking cards */}
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <RankingSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

/** Skeleton for the courses page */
export function CoursesPageSkeleton() {
  return (
    <div className="px-4 pt-6">
      <Skeleton className="mb-4 h-6 w-28" />
      <Skeleton className="mb-6 h-10 w-full rounded-md" />
      <div className="space-y-2">
        <Skeleton className="h-3 w-20" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between rounded-lg border p-3">
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <Skeleton className="h-8 w-16 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Skeleton for the profile page */
export function ProfilePageSkeleton() {
  return (
    <div className="px-4 pt-6">
      <Skeleton className="mb-6 h-6 w-16" />
      <div className="space-y-4">
        {/* User info */}
        <div className="rounded-lg border bg-card p-4">
          <Skeleton className="mb-1.5 h-3 w-16" />
          <Skeleton className="h-5 w-32" />
        </div>
        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-lg border bg-card p-3 text-center">
              <Skeleton className="mx-auto mb-1 h-7 w-10" />
              <Skeleton className="mx-auto h-3 w-16" />
            </div>
          ))}
        </div>
        {/* Top course */}
        <div className="rounded-lg border bg-card p-4">
          <Skeleton className="mb-1.5 h-3 w-24" />
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-1 h-3 w-28" />
        </div>
        {/* Theme toggle */}
        <div className="rounded-lg border bg-card p-4">
          <Skeleton className="mb-3 h-3 w-20" />
          <div className="flex gap-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 flex-1 rounded-lg" />
            ))}
          </div>
        </div>
        <Skeleton className="h-10 w-full rounded-md" />
      </div>
    </div>
  );
}

/** Skeleton for a single history timeline entry */
function HistoryEntrySkeleton() {
  return (
    <div className="relative flex gap-3 pl-5">
      <div className="absolute left-[-3px] top-2 h-[7px] w-[7px] rounded-full bg-secondary" />
      <div className="min-w-0 flex-1 rounded-lg border bg-card p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-8" />
            <Skeleton className="h-4 w-2/3" />
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Skeleton className="h-4 w-10 rounded-full" />
            <Skeleton className="h-3 w-12" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Skeleton for the history page */
export function HistoryPageSkeleton() {
  return (
    <div className="px-4 pt-6 pb-8">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <Skeleton className="h-8 w-8 rounded-lg" />
        <div className="space-y-1.5">
          <Skeleton className="h-6 w-44" />
          <Skeleton className="h-3 w-28" />
        </div>
      </div>
      {/* Date group */}
      <div className="space-y-6">
        <div>
          <div className="mb-3 flex items-center gap-2">
            <Skeleton className="h-3 w-16" />
            <div className="h-px flex-1 bg-border" />
          </div>
          <div className="relative ml-3">
            <div className="absolute left-0 top-2 bottom-2 w-px bg-border" />
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <HistoryEntrySkeleton key={i} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Skeleton for the compare page */
export function ComparePageSkeleton() {
  return (
    <div className="px-4 pt-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="space-y-1.5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-28" />
        </div>
        <Skeleton className="h-8 w-14 rounded-md" />
      </div>
      <Skeleton className="mb-6 h-1.5 w-full rounded-full" />
      <div className="space-y-3">
        <Skeleton className="h-28 w-full rounded-xl" />
        <div className="flex items-center justify-center py-1">
          <Skeleton className="h-8 w-8 rounded-full" />
        </div>
        <Skeleton className="h-28 w-full rounded-xl" />
      </div>
    </div>
  );
}
