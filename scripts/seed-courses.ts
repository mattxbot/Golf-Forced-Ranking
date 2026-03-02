/**
 * Seed script: imports golf courses from data/courses-seed.json into Supabase.
 *
 * Usage: npm run seed
 * Requires: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars.
 *
 * Uses service role key to bypass RLS for seeding.
 * Quality gate [RecSys Fix #3]: requires 6+ of 9 attributes per course.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

const REQUIRED_ATTR_COUNT = 6;
const ATTRIBUTES = [
  "walkability",
  "scenery",
  "conditioning",
  "strategy_complexity",
  "difficulty",
  "architectural_interest",
  "historical_significance",
  "exclusivity",
  "vibe",
] as const;

interface SeedCourse {
  name: string;
  city?: string;
  state_province?: string;
  country?: string;
  architect?: string;
  year_built?: number;
  course_type?: string;
  holes?: number;
  par?: number;
  walkability?: number;
  scenery?: number;
  conditioning?: number;
  strategy_complexity?: number;
  difficulty?: number;
  architectural_interest?: number;
  historical_significance?: number;
  exclusivity?: number;
  vibe?: number;
}

function slugify(name: string, city?: string, state?: string): string {
  return [name, city, state]
    .filter(Boolean)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function attributeCoverage(course: SeedCourse): number {
  return ATTRIBUTES.filter(
    (attr) => course[attr] !== undefined && course[attr] !== null
  ).length;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error(
      "Missing env vars. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    );
    process.exit(1);
  }

  const supabase = createClient(url, key);

  // Load seed data
  const dataPath = resolve(__dirname, "../data/courses-seed.json");
  const raw = readFileSync(dataPath, "utf-8");
  const courses: SeedCourse[] = JSON.parse(raw);

  console.log(`Loaded ${courses.length} courses from seed file.`);

  // Quality gate: check attribute coverage
  const qualified: SeedCourse[] = [];
  const rejected: string[] = [];

  for (const course of courses) {
    const coverage = attributeCoverage(course);
    if (coverage >= REQUIRED_ATTR_COUNT) {
      qualified.push(course);
    } else {
      rejected.push(
        `${course.name} (${coverage}/${ATTRIBUTES.length} attributes)`
      );
    }
  }

  if (rejected.length > 0) {
    console.warn(
      `\nWARNING: ${rejected.length} courses rejected (< ${REQUIRED_ATTR_COUNT} attributes):`
    );
    rejected.forEach((r) => console.warn(`  - ${r}`));
  }

  console.log(
    `\n${qualified.length} courses pass quality gate (${REQUIRED_ATTR_COUNT}+ attributes).`
  );

  // Prepare rows for insert
  const rows = qualified.map((course) => ({
    name: course.name,
    slug: slugify(course.name, course.city, course.state_province),
    city: course.city ?? null,
    state_province: course.state_province ?? null,
    country: course.country ?? "US",
    architect: course.architect ?? null,
    year_built: course.year_built ?? null,
    course_type: course.course_type ?? null,
    holes: course.holes ?? 18,
    par: course.par ?? null,
    walkability: course.walkability ?? null,
    scenery: course.scenery ?? null,
    conditioning: course.conditioning ?? null,
    strategy_complexity: course.strategy_complexity ?? null,
    difficulty: course.difficulty ?? null,
    architectural_interest: course.architectural_interest ?? null,
    historical_significance: course.historical_significance ?? null,
    exclusivity: course.exclusivity ?? null,
    vibe: course.vibe ?? null,
    is_verified: true,
    created_by: null,
  }));

  // Upsert to avoid duplicates on re-run
  const { data, error } = await supabase
    .from("courses")
    .upsert(rows, { onConflict: "slug" })
    .select("id, name");

  if (error) {
    console.error("Seed failed:", error.message);
    process.exit(1);
  }

  console.log(`\nSeeded ${data.length} courses successfully.`);
}

main();
