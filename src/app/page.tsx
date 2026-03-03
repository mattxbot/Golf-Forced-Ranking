import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Check if user has enough courses to skip onboarding
  const { count } = await supabase
    .from("user_courses")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id);

  if (!count || count < 3) {
    redirect("/onboarding");
  }

  redirect("/rankings");
}
