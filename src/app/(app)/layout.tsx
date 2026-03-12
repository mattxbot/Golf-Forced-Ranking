import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { BottomNav } from "@/components/bottom-nav";
import { ErrorBoundary } from "@/components/error-boundary";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div className="min-h-dvh pb-20 md:pb-0 md:pl-20">
      <div className="mx-auto max-w-lg px-0 md:px-6 md:py-4">
        <ErrorBoundary>
          {children}
        </ErrorBoundary>
      </div>
      <BottomNav />
    </div>
  );
}
