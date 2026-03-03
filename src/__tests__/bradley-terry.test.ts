import { describe, it, expect } from "vitest";
import {
  computeRankings,
  computeRankingsDetailed,
  overallConfidence,
  findConnectedComponents,
  type ComparisonInput,
} from "@/lib/ranking/bradley-terry";
import { canonicalizePair } from "@/lib/utils";

// ─── Helpers ──────────────────────────────────────────────────────────
// Build a correctly-formed ComparisonInput where winnerId wins.
// winner field is "a" if course_a_id won, "b" if course_b_id won.
function c(aId: string, bId: string, winnerId: string): ComparisonInput {
  return {
    course_a_id: aId,
    course_b_id: bId,
    winner: winnerId === aId ? "a" : "b",
  };
}

// ─── canonicalizePair ─────────────────────────────────────────────────
describe("canonicalizePair", () => {
  it("places lexicographically smaller ID as course_a", () => {
    const result = canonicalizePair("aaa", "bbb");
    expect(result.course_a_id).toBe("aaa");
    expect(result.course_b_id).toBe("bbb");
    expect(result.winner).toBe("a");
  });

  it("is symmetric — same winner regardless of argument order", () => {
    const r1 = canonicalizePair("bbb", "aaa"); // bbb wins
    const r2 = canonicalizePair("aaa", "bbb"); // aaa wins

    expect(r1).toEqual({ course_a_id: "aaa", course_b_id: "bbb", winner: "b" });
    expect(r2).toEqual({ course_a_id: "aaa", course_b_id: "bbb", winner: "a" });
  });
});

// ─── findConnectedComponents ──────────────────────────────────────────
describe("findConnectedComponents", () => {
  it("returns one component for a fully connected graph", () => {
    const ids = ["a", "b", "c"];
    const comps: ComparisonInput[] = [c("a", "b", "a"), c("b", "c", "b")];
    const result = findConnectedComponents(ids, comps);
    expect(result).toHaveLength(1);
    expect(result[0].size).toBe(3);
  });

  it("detects two disconnected components", () => {
    const ids = ["a", "b", "c", "d"];
    const comps: ComparisonInput[] = [c("a", "b", "a"), c("c", "d", "c")];
    const result = findConnectedComponents(ids, comps);
    expect(result).toHaveLength(2);
    const sizes = result.map((x) => x.size).sort();
    expect(sizes).toEqual([2, 2]);
  });

  it("handles isolated nodes (no comparisons)", () => {
    const ids = ["a", "b", "c"];
    const comps: ComparisonInput[] = [c("a", "b", "a")];
    const result = findConnectedComponents(ids, comps);
    expect(result).toHaveLength(2);
  });
});

// ─── computeRankings: basic correctness ───────────────────────────────
describe("computeRankings", () => {
  it("returns empty array for no courses", () => {
    expect(computeRankings([], [])).toEqual([]);
  });

  it("handles single course", () => {
    const result = computeRankings(["a"], []);
    expect(result).toHaveLength(1);
    expect(result[0].rank).toBe(1);
    expect(result[0].confidence).toBe(0);
  });

  it("ranks a dominant course #1 in a 3-course scenario", () => {
    // A beats B, A beats C, B beats C → A > B > C
    const comps: ComparisonInput[] = [
      c("a", "b", "a"),
      c("a", "c", "a"),
      c("b", "c", "b"),
    ];
    const result = computeRankings(["a", "b", "c"], comps);

    expect(result[0].course_id).toBe("a");
    expect(result[1].course_id).toBe("b");
    expect(result[2].course_id).toBe("c");
    expect(result[0].bt_score).toBeGreaterThan(result[1].bt_score);
    expect(result[1].bt_score).toBeGreaterThan(result[2].bt_score);
  });

  it("assigns correct ranks", () => {
    const result = computeRankings(["a", "b"], [c("a", "b", "a")]);
    expect(result[0].rank).toBe(1);
    expect(result[1].rank).toBe(2);
  });

  it("max score is 10.0 for the top-ranked course", () => {
    const comps: ComparisonInput[] = [c("a", "b", "a"), c("a", "c", "a")];
    const result = computeRankings(["a", "b", "c"], comps);
    expect(result[0].bt_score).toBe(10);
  });
});

// ─── all-losses with Laplace smoothing ────────────────────────────────
describe("computeRankings: Laplace smoothing", () => {
  it("all-losses course gets a non-zero score", () => {
    const comps: ComparisonInput[] = [
      c("a", "b", "a"),
      c("a", "c", "a"),
      c("b", "c", "b"),
    ];
    const result = computeRankings(["a", "b", "c"], comps);
    const cEntry = result.find((r) => r.course_id === "c")!;
    expect(cEntry.bt_score).toBeGreaterThan(0);
  });

  it("losing to strong opponents scores higher than losing to weak", () => {
    // A>B>C>D>E complete chain. X lost to A,B. Y lost to D,E.
    const comps: ComparisonInput[] = [
      c("a", "b", "a"), c("a", "c", "a"), c("a", "d", "a"), c("a", "e", "a"),
      c("b", "c", "b"), c("b", "d", "b"), c("b", "e", "b"),
      c("c", "d", "c"), c("c", "e", "c"),
      c("d", "e", "d"),
      c("a", "x", "a"), c("b", "x", "b"), // X lost to top-2
      c("d", "y", "d"), c("e", "y", "e"), // Y lost to bottom-2
    ];
    const result = computeRankings(["a", "b", "c", "d", "e", "x", "y"], comps);

    const xEntry = result.find((r) => r.course_id === "x")!;
    const yEntry = result.find((r) => r.course_id === "y")!;
    expect(xEntry.bt_score).toBeGreaterThan(yEntry.bt_score);
  });
});

// ─── disconnected graph ───────────────────────────────────────────────
describe("computeRankings: disconnected graph", () => {
  it("component leaders each get score 10", () => {
    const comps: ComparisonInput[] = [c("a", "b", "a"), c("c", "d", "c")];
    const result = computeRankings(["a", "b", "c", "d"], comps);

    const aEntry = result.find((r) => r.course_id === "a")!;
    const cEntry = result.find((r) => r.course_id === "c")!;
    expect(aEntry.bt_score).toBe(10);
    expect(cEntry.bt_score).toBe(10);
  });

  it("inactive courses appear at the end", () => {
    const result = computeRankings(["a", "b", "c"], [c("a", "b", "a")]);
    const cEntry = result.find((r) => r.course_id === "c")!;
    expect(cEntry.rank).toBe(3);
    expect(cEntry.confidence).toBe(0);
    expect(cEntry.comparison_count).toBe(0);
  });
});

// ─── confidence metric (v3: weighted coverage) ─────────────────────────
describe("computeRankings: confidence", () => {
  it("higher confidence with more unique opponents", () => {
    const comps: ComparisonInput[] = [
      c("a", "x", "a"),                                          // X: 1 opponent
      c("a", "y", "y"), c("b", "y", "y"), c("c", "y", "y"),     // Y: 3 opponents
      c("d", "y", "y"), c("e", "y", "y"),                        // Y: 5 total
      c("a", "b", "a"), c("c", "d", "c"), c("d", "e", "d"),
    ];
    const result = computeRankings(["a", "b", "c", "d", "e", "x", "y"], comps);
    const xConf = result.find((r) => r.course_id === "x")!.confidence;
    const yConf = result.find((r) => r.course_id === "y")!.confidence;
    expect(yConf).toBeGreaterThan(xConf);
  });

  it("repeat comparisons increase confidence (diminishing returns)", () => {
    // Same opponent but compared multiple times
    const comps1: ComparisonInput[] = [c("a", "b", "a")];
    const comps3: ComparisonInput[] = [
      c("a", "b", "a"), c("a", "b", "a"), c("a", "b", "a"),
    ];
    const result1 = computeRankings(["a", "b"], comps1);
    const result3 = computeRankings(["a", "b"], comps3);
    const conf1 = result1.find((r) => r.course_id === "a")!.confidence;
    const conf3 = result3.find((r) => r.course_id === "a")!.confidence;
    expect(conf3).toBeGreaterThan(conf1);
  });

  it("confidence is zero for inactive courses", () => {
    const result = computeRankings(["a", "b", "c"], [c("a", "b", "a")]);
    expect(result.find((r) => r.course_id === "c")!.confidence).toBe(0);
  });
});

// ─── tie-breaking ───────────────────────────────────────────────────
describe("computeRankings: tie-breaking", () => {
  it("deterministic rank for tied scores", () => {
    // Two disconnected pairs → both leaders get 10.0
    const comps: ComparisonInput[] = [c("a", "b", "a"), c("c", "d", "c")];
    const r1 = computeRankings(["a", "b", "c", "d"], comps);
    const r2 = computeRankings(["a", "b", "c", "d"], comps);
    // Same ranking order every time
    expect(r1.map((r) => r.course_id)).toEqual(r2.map((r) => r.course_id));
  });

  it("ties broken by confidence then comparison_count then course_id", () => {
    // Two disconnected pairs with equal scores
    const comps: ComparisonInput[] = [c("a", "b", "a"), c("c", "d", "c")];
    const result = computeRankings(["a", "b", "c", "d"], comps);
    // Both a and c score 10.0 — tie-break falls to course_id: "a" < "c"
    expect(result[0].course_id).toBe("a");
    expect(result[1].course_id).toBe("c");
  });
});

// ─── no double-counting ──────────────────────────────────────────────
describe("computeRankings: no double-counting", () => {
  it("symmetric results regardless of ID ordering in input", () => {
    const r1 = computeRankings(["aaa", "zzz"], [
      { course_a_id: "aaa", course_b_id: "zzz", winner: "a" },
    ]);
    const r2 = computeRankings(["aaa", "zzz"], [
      { course_a_id: "zzz", course_b_id: "aaa", winner: "b" },
    ]);
    expect(r1[0].course_id).toBe(r2[0].course_id);
    expect(r1[0].bt_score).toBeCloseTo(r2[0].bt_score, 3);
  });
});

// ─── computeRankingsDetailed ─────────────────────────────────────────
describe("computeRankingsDetailed", () => {
  it("reports convergence for simple cases", () => {
    const comps: ComparisonInput[] = [
      c("a", "b", "a"), c("a", "c", "a"), c("b", "c", "b"),
    ];
    const result = computeRankingsDetailed(["a", "b", "c"], comps);
    expect(result.converged).toBe(true);
    expect(result.iterations).toBeGreaterThan(0);
    expect(result.iterations).toBeLessThanOrEqual(50);
    expect(result.maxDelta).toBeLessThan(1e-8);
  });

  it("returns same rankings as computeRankings", () => {
    const comps: ComparisonInput[] = [
      c("a", "b", "a"), c("a", "c", "a"), c("b", "c", "b"),
    ];
    const detailed = computeRankingsDetailed(["a", "b", "c"], comps);
    const simple = computeRankings(["a", "b", "c"], comps);
    expect(detailed.rankings).toEqual(simple);
  });

  it("reports no iterations for empty/single inputs", () => {
    expect(computeRankingsDetailed([], []).iterations).toBe(0);
    expect(computeRankingsDetailed(["a"], []).iterations).toBe(0);
  });
});

// ─── overallConfidence ────────────────────────────────────────────────
describe("overallConfidence", () => {
  it("returns 0 for empty rankings", () => {
    expect(overallConfidence([])).toBe(0);
  });

  it("computes average confidence as percentage", () => {
    const rankings = [
      { course_id: "a", bt_score: 10, rank: 1, comparison_count: 3, confidence: 1.0 },
      { course_id: "b", bt_score: 5, rank: 2, comparison_count: 1, confidence: 0.5 },
    ];
    expect(overallConfidence(rankings)).toBe(75);
  });
});
