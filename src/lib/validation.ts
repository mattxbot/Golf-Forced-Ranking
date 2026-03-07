/**
 * Input validation schemas.
 *
 * All user-facing mutations and queries should validate through these
 * schemas before hitting Supabase. This is the single source of truth
 * for input constraints.
 */

import { z } from "zod";

// ─── Auth ─────────────────────────────────────────────────────────────

export const signupSchema = z.object({
  email: z.string().email("Invalid email address").max(254),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(24, "Username must be at most 24 characters")
    .regex(
      /^[a-zA-Z0-9_]+$/,
      "Username can only contain letters, numbers, and underscores"
    ),
});

export const loginSchema = z.object({
  email: z.string().email("Invalid email address").max(254),
  password: z.string().min(1, "Password is required").max(128),
});

// ─── Search ───────────────────────────────────────────────────────────

export const searchQuerySchema = z
  .string()
  .trim()
  .min(2, "Search query too short")
  .max(100, "Search query too long");

// ─── Comparison ───────────────────────────────────────────────────────

export const comparisonSchema = z.object({
  course_a_id: z.string().uuid(),
  course_b_id: z.string().uuid(),
  winner: z.enum(["a", "b"]),
  decided_in_ms: z.number().int().nonnegative().max(300_000).nullable(),
});

// ─── Course add ───────────────────────────────────────────────────────

export const courseAddSchema = z.object({
  course_id: z.string().uuid(),
});

// ─── Course create ────────────────────────────────────────────────────

export const courseCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Course name must be at least 2 characters")
    .max(120, "Course name too long"),
  city: z.string().trim().max(100).optional().or(z.literal("")),
  state_province: z.string().trim().max(100).optional().or(z.literal("")),
  course_type: z
    .enum(["links", "parkland", "desert", "mountain", "resort", "municipal", "private"])
    .optional(),
  holes: z.coerce.number().int().min(1).max(36).optional(),
  par: z.coerce.number().int().min(27).max(80).optional(),
});
