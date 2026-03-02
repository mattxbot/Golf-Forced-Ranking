"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

export default function ProfilePage() {
  const [username, setUsername] = useState("");
  const [courseCount, setCourseCount] = useState(0);
  const [comparisonCount, setComparisonCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const profileRes = await (supabase.from("profiles") as any)
        .select("username").eq("id", user.id).single() as { data: { username: string } | null };
      const coursesRes = await supabase
        .from("user_courses")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id);
      const compsRes = await supabase
        .from("comparisons")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id);

      setUsername(profileRes.data?.username ?? user.email ?? "");
      setCourseCount(coursesRes.count ?? 0);
      setComparisonCount(compsRes.count ?? 0);
      setLoading(false);
    }
    load();
  }, [supabase]);

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center pt-32">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="px-4 pt-6">
      <h1 className="mb-6 text-xl font-semibold">Profile</h1>

      <div className="space-y-6">
        <div className="rounded-lg border p-4">
          <p className="text-sm text-muted-foreground">Username</p>
          <p className="text-base font-medium">{username}</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border p-4 text-center">
            <p className="text-2xl font-bold">{courseCount}</p>
            <p className="text-xs text-muted-foreground">Courses played</p>
          </div>
          <div className="rounded-lg border p-4 text-center">
            <p className="text-2xl font-bold">{comparisonCount}</p>
            <p className="text-xs text-muted-foreground">Comparisons</p>
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
