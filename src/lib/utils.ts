import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function slugify(name: string, city?: string | null, state?: string | null): string {
  const parts = [name, city, state].filter(Boolean).join("-");
  return parts
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Canonicalize a course pair so course_a < course_b (UUID lexicographic order).
 * Returns [course_a_id, course_b_id, winner_is_a_or_b].
 */
export function canonicalizePair(
  selectedId: string,
  otherId: string
): { course_a_id: string; course_b_id: string; winner: "a" | "b" } {
  if (selectedId < otherId) {
    return { course_a_id: selectedId, course_b_id: otherId, winner: "a" };
  } else {
    return { course_a_id: otherId, course_b_id: selectedId, winner: "b" };
  }
}
