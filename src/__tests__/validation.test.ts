import { describe, it, expect } from "vitest";
import {
  signupSchema,
  loginSchema,
  searchQuerySchema,
  comparisonSchema,
  courseAddSchema,
} from "@/lib/validation";

// ─── signupSchema ─────────────────────────────────────────────────────
describe("signupSchema", () => {
  it("accepts valid signup data", () => {
    const result = signupSchema.safeParse({
      email: "user@example.com",
      password: "securepass123",
      username: "golf_fan",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid email", () => {
    const result = signupSchema.safeParse({
      email: "not-an-email",
      password: "securepass",
      username: "user",
    });
    expect(result.success).toBe(false);
  });

  it("rejects short password", () => {
    const result = signupSchema.safeParse({
      email: "user@example.com",
      password: "short",
      username: "user",
    });
    expect(result.success).toBe(false);
  });

  it("rejects short username", () => {
    const result = signupSchema.safeParse({
      email: "user@example.com",
      password: "securepass",
      username: "ab",
    });
    expect(result.success).toBe(false);
  });

  it("rejects long username", () => {
    const result = signupSchema.safeParse({
      email: "user@example.com",
      password: "securepass",
      username: "a".repeat(25),
    });
    expect(result.success).toBe(false);
  });

  it("rejects username with special characters", () => {
    const result = signupSchema.safeParse({
      email: "user@example.com",
      password: "securepass",
      username: "user@name",
    });
    expect(result.success).toBe(false);
  });

  it("accepts username with underscores", () => {
    const result = signupSchema.safeParse({
      email: "user@example.com",
      password: "securepass",
      username: "golf_player_1",
    });
    expect(result.success).toBe(true);
  });
});

// ─── loginSchema ──────────────────────────────────────────────────────
describe("loginSchema", () => {
  it("accepts valid login data", () => {
    const result = loginSchema.safeParse({
      email: "user@example.com",
      password: "mypassword",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty password", () => {
    const result = loginSchema.safeParse({
      email: "user@example.com",
      password: "",
    });
    expect(result.success).toBe(false);
  });
});

// ─── searchQuerySchema ────────────────────────────────────────────────
describe("searchQuerySchema", () => {
  it("accepts valid search query", () => {
    const result = searchQuerySchema.safeParse("Pine Valley");
    expect(result.success).toBe(true);
  });

  it("trims whitespace", () => {
    const result = searchQuerySchema.safeParse("  Augusta  ");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("Augusta");
    }
  });

  it("rejects single character", () => {
    const result = searchQuerySchema.safeParse("a");
    expect(result.success).toBe(false);
  });

  it("rejects query over 100 chars", () => {
    const result = searchQuerySchema.safeParse("a".repeat(101));
    expect(result.success).toBe(false);
  });

  it("accepts exactly 100 chars", () => {
    const result = searchQuerySchema.safeParse("a".repeat(100));
    expect(result.success).toBe(true);
  });
});

// ─── comparisonSchema ─────────────────────────────────────────────────
describe("comparisonSchema", () => {
  it("accepts valid comparison", () => {
    const result = comparisonSchema.safeParse({
      course_a_id: "550e8400-e29b-41d4-a716-446655440000",
      course_b_id: "660e8400-e29b-41d4-a716-446655440001",
      winner: "a",
      decided_in_ms: 1500,
    });
    expect(result.success).toBe(true);
  });

  it("accepts null decided_in_ms", () => {
    const result = comparisonSchema.safeParse({
      course_a_id: "550e8400-e29b-41d4-a716-446655440000",
      course_b_id: "660e8400-e29b-41d4-a716-446655440001",
      winner: "b",
      decided_in_ms: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid winner", () => {
    const result = comparisonSchema.safeParse({
      course_a_id: "550e8400-e29b-41d4-a716-446655440000",
      course_b_id: "660e8400-e29b-41d4-a716-446655440001",
      winner: "c",
      decided_in_ms: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-UUID course IDs", () => {
    const result = comparisonSchema.safeParse({
      course_a_id: "not-a-uuid",
      course_b_id: "also-not-uuid",
      winner: "a",
      decided_in_ms: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative decided_in_ms", () => {
    const result = comparisonSchema.safeParse({
      course_a_id: "550e8400-e29b-41d4-a716-446655440000",
      course_b_id: "660e8400-e29b-41d4-a716-446655440001",
      winner: "a",
      decided_in_ms: -100,
    });
    expect(result.success).toBe(false);
  });
});

// ─── courseAddSchema ──────────────────────────────────────────────────
describe("courseAddSchema", () => {
  it("accepts valid UUID", () => {
    const result = courseAddSchema.safeParse({
      course_id: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-UUID", () => {
    const result = courseAddSchema.safeParse({
      course_id: "invalid",
    });
    expect(result.success).toBe(false);
  });
});
