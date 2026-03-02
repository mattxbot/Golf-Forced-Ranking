/**
 * Bradley-Terry ranking engine.
 *
 * Computes latent quality scores from pairwise comparison data via
 * maximum likelihood estimation. Pure function, no side effects.
 *
 * Algorithm: iterative MLE (MM algorithm for BT model)
 *   θ_i = w_i / Σ_j [n_ij / (θ_i + θ_j)]
 * where w_i = total wins for item i, n_ij = total comparisons between i and j.
 *
 * Reference: Hunter, 2004. "MM algorithms for generalized Bradley-Terry models."
 */

import type { RankingEntry } from "@/types/database";

interface ComparisonInput {
  course_a_id: string;
  course_b_id: string;
  winner: "a" | "b";
}

const MAX_ITERATIONS = 20;
const CONVERGENCE_THRESHOLD = 1e-6;
const DEFAULT_SCORE = 0.5; // For courses with 0 comparisons

/**
 * Compute Bradley-Terry rankings from pairwise comparisons.
 *
 * @param courseIds - All course IDs to rank
 * @param comparisons - Pairwise comparison outcomes
 * @returns Ranked list with BT scores, positions, and confidence
 */
export function computeRankings(
  courseIds: string[],
  comparisons: ComparisonInput[]
): RankingEntry[] {
  if (courseIds.length === 0) return [];
  if (courseIds.length === 1) {
    return [
      {
        course_id: courseIds[0],
        bt_score: 1.0,
        rank: 1,
        comparison_count: 0,
        confidence: 0,
      },
    ];
  }

  // Build win counts and comparison graph
  const wins = new Map<string, number>();
  const comparisonGraph = new Map<string, Map<string, number>>();
  const compCounts = new Map<string, number>();

  for (const id of courseIds) {
    wins.set(id, 0);
    comparisonGraph.set(id, new Map());
    compCounts.set(id, 0);
  }

  for (const comp of comparisons) {
    const winnerId = comp.winner === "a" ? comp.course_a_id : comp.course_b_id;
    const { course_a_id, course_b_id } = comp;

    // Only process comparisons involving courses in our set
    if (!wins.has(course_a_id) || !wins.has(course_b_id)) continue;

    wins.set(winnerId, (wins.get(winnerId) ?? 0) + 1);
    compCounts.set(course_a_id, (compCounts.get(course_a_id) ?? 0) + 1);
    compCounts.set(course_b_id, (compCounts.get(course_b_id) ?? 0) + 1);

    // Track how many times each pair was compared
    const graphA = comparisonGraph.get(course_a_id)!;
    graphA.set(course_b_id, (graphA.get(course_b_id) ?? 0) + 1);

    const graphB = comparisonGraph.get(course_b_id)!;
    graphB.set(course_a_id, (graphB.get(course_a_id) ?? 0) + 1);
  }

  // Identify courses with at least one comparison (BT requires this)
  const activeCourses = courseIds.filter((id) => (compCounts.get(id) ?? 0) > 0);
  const inactiveCourses = courseIds.filter((id) => (compCounts.get(id) ?? 0) === 0);

  // Initialize scores
  const scores = new Map<string, number>();
  for (const id of activeCourses) {
    scores.set(id, 1.0);
  }

  // Iterative MLE (MM algorithm)
  if (activeCourses.length >= 2) {
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      let maxDelta = 0;

      for (const i of activeCourses) {
        const w_i = wins.get(i) ?? 0;
        if (w_i === 0) {
          // Course lost every comparison — set small but nonzero score
          const oldScore = scores.get(i) ?? 1.0;
          const newScore = 0.01;
          maxDelta = Math.max(maxDelta, Math.abs(newScore - oldScore));
          scores.set(i, newScore);
          continue;
        }

        const neighbors = comparisonGraph.get(i)!;
        let denominator = 0;

        for (const [j, n_ij] of neighbors) {
          const score_i = scores.get(i) ?? 1.0;
          const score_j = scores.get(j) ?? 1.0;
          denominator += n_ij / (score_i + score_j);
        }

        if (denominator === 0) continue;

        const newScore = w_i / denominator;
        const oldScore = scores.get(i) ?? 1.0;
        maxDelta = Math.max(maxDelta, Math.abs(newScore - oldScore));
        scores.set(i, newScore);
      }

      if (maxDelta < CONVERGENCE_THRESHOLD) break;
    }
  }

  // Normalize scores: max active score = 10.0
  const maxScore = Math.max(...Array.from(scores.values()), 0.01);
  for (const [id, score] of scores) {
    scores.set(id, (score / maxScore) * 10);
  }

  // Build results: active courses with BT scores, inactive with default
  const totalCourses = courseIds.length;
  const logN = Math.ceil(Math.log2(Math.max(totalCourses, 2)));

  const results: RankingEntry[] = [];

  for (const id of activeCourses) {
    const count = compCounts.get(id) ?? 0;
    results.push({
      course_id: id,
      bt_score: round(scores.get(id) ?? 0, 4),
      rank: 0, // Set after sorting
      comparison_count: count,
      confidence: round(Math.min(1.0, count / logN), 3),
    });
  }

  // Sort by BT score descending
  results.sort((a, b) => b.bt_score - a.bt_score);

  // Assign ranks
  for (let i = 0; i < results.length; i++) {
    results[i].rank = i + 1;
  }

  // Append inactive courses at the end
  for (const id of inactiveCourses) {
    results.push({
      course_id: id,
      bt_score: round(DEFAULT_SCORE, 4),
      rank: results.length + 1,
      comparison_count: 0,
      confidence: 0,
    });
  }

  return results;
}

/**
 * Compute overall ranking confidence as a percentage.
 */
export function overallConfidence(rankings: RankingEntry[]): number {
  if (rankings.length === 0) return 0;
  const avg =
    rankings.reduce((sum, r) => sum + r.confidence, 0) / rankings.length;
  return round(avg * 100, 0);
}

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
