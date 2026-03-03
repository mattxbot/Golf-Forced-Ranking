"use client";

import { Button } from "@/components/ui/button";

export function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 pt-24 text-center">
      <h1 className="text-xl font-semibold">Failed to load</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Check your connection and try again.
      </p>
      <Button className="mt-6" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
