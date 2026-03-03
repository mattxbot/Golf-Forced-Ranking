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

export interface ComparisonInput {
  course_a_id: string;
  course_b_id: string;
  winner: "a" | "b";
}

export const ALGORITHM_VERSION = 2;
const MAX_ITERATIONS = 50;
const CONVERGENCE_THRESHOLD = 1e-8;
const LAPLACE_PSEUDO_COUNT = 0.5;
const DEFAULT_SCORE = 0.5;

/**
 * Find connected components in the comparison graph via BFS.
 * Returns an array of components, each being a Set of course IDs.
 */
export function findConnectedComponents(
  courseIds: string[],
  comparisons: ComparisonInput[]
): Set<string>[] {
  const courseSet = new Set(courseIds);

  // Build adjacency list (undirected)
  const adjacency = new Map<string, Set<string>>();
  for (const id of courseIds) {
    adjacency.set(id, new Set());
  }
  for (const comp of comparisons) {
    if (!courseSet.has(comp.course_a_id) || !courseSet.has(comp.course_b_id)) continue;
    adjacency.get(comp.course_a_id)!.add(comp.course_b_id);
    adjacency.get(comp.course_b_id)!.add(comp.course_a_id);
  }

  const visited = new Set<string>();
  const components: Set<string>[] = [];

  for (const id of courseIds) {
    if (visited.has(id)) continue;
    const component = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.add(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
    components.push(component);
  }

  return components;
}

/**
 * Compute Bradley-Terry rankings from pairwise comparisons.
 *
 * Fixes over v1:
 * - Stores edges asymmetrically (only a→b where a < b) to prevent double-counting
 * - Detects disconnected components and ranks within each independently
 * - Uses Laplace smoothing instead of hardcoded scores for all-losses case
 * - Confidence based on unique opponents rather than raw comparison count
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

  const courseSet = new Set(courseIds);

  // Filter to relevant comparisons
  const relevantComps = comparisons.filter(
    (c) => courseSet.has(c.course_a_id) && courseSet.has(c.course_b_id)
  );

  // Build win counts, comparison counts, and unique opponents
  const wins = new Map<string, number>();
  const compCounts = new Map<string, number>();
  const uniqueOpponents = new Map<string, Set<string>>();

  for (const id of courseIds) {
    wins.set(id, 0);
    compCounts.set(id, 0);
    uniqueOpponents.set(id, new Set());
  }

  // Asymmetric edge map: only store (min_id, max_id) to prevent double-counting.
  // Key: "idA:idB" where idA < idB. Value: total comparisons between them.
  const edgeMap = new Map<string, number>();

  for (const comp of relevantComps) {
    const winnerId = comp.winner === "a" ? comp.course_a_id : comp.course_b_id;

    // Wins include Laplace pseudo-counts added later
    wins.set(winnerId, (wins.get(winnerId) ?? 0) + 1);
    compCounts.set(comp.course_a_id, (compCounts.get(comp.course_a_id) ?? 0) + 1);
    compCounts.set(comp.course_b_id, (compCounts.get(comp.course_b_id) ?? 0) + 1);
    uniqueOpponents.get(comp.course_a_id)!.add(comp.course_b_id);
    uniqueOpponents.get(comp.course_b_id)!.add(comp.course_a_id);

    // Canonical edge key (asymmetric — no double-counting)
    const edgeKey =
      comp.course_a_id < comp.course_b_id
        ? `${comp.course_a_id}:${comp.course_b_id}`
        : `${comp.course_b_id}:${comp.course_a_id}`;
    edgeMap.set(edgeKey, (edgeMap.get(edgeKey) ?? 0) + 1);
  }

  // Identify active (compared) vs inactive (uncompared) courses
  const activeCourses = courseIds.filter((id) => (compCounts.get(id) ?? 0) > 0);
  const inactiveCourses = courseIds.filter((id) => (compCounts.get(id) ?? 0) === 0);

  // Find connected components among active courses
  const components = findConnectedComponents(activeCourses, relevantComps);

  // Apply Laplace smoothing: add pseudo-counts for each observed edge.
  // This ensures every course has at least some fractional wins, preventing
  // division-by-zero for all-losses courses while preserving relative ordering.
  const smoothedWins = new Map<string, number>();
  for (const id of activeCourses) {
    smoothedWins.set(id, wins.get(id) ?? 0);
  }
  const smoothedEdgeMap = new Map<string, number>();
  for (const [key, count] of edgeMap) {
    smoothedEdgeMap.set(key, count + 2 * LAPLACE_PSEUDO_COUNT);
    // Add pseudo-wins for both sides of each edge
    const [idA, idB] = key.split(":");
    smoothedWins.set(idA, (smoothedWins.get(idA) ?? 0) + LAPLACE_PSEUDO_COUNT);
    smoothedWins.set(idB, (smoothedWins.get(idB) ?? 0) + LAPLACE_PSEUDO_COUNT);
  }

  // Run BT-MLE independently per connected component
  const scores = new Map<string, number>();

  for (const component of components) {
    const componentIds = Array.from(component);

    if (componentIds.length === 1) {
      scores.set(componentIds[0], 1.0);
      continue;
    }

    // Initialize scores
    for (const id of componentIds) {
      scores.set(id, 1.0);
    }

    // Iterative MLE (MM algorithm)
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      let maxDelta = 0;

      for (const i of componentIds) {
        const w_i = smoothedWins.get(i) ?? 0;

        // Compute denominator by iterating over edges involving i
        let denominator = 0;
        for (const j of componentIds) {
          if (i === j) continue;
          const edgeKey = i < j ? `${i}:${j}` : `${j}:${i}`;
          const n_ij = smoothedEdgeMap.get(edgeKey);
          if (n_ij === undefined) continue;

          const score_i = scores.get(i)!;
          const score_j = scores.get(j)!;
          denominator += n_ij / (score_i + score_j);
        }

        if (denominator === 0) continue;

        const newScore = w_i / denominator;
        const oldScore = scores.get(i)!;
        maxDelta = Math.max(maxDelta, Math.abs(newScore - oldScore));
        scores.set(i, newScore);
      }

      if (maxDelta < CONVERGENCE_THRESHOLD) break;
    }

    // Normalize within component: max = 10.0
    let maxComponentScore = 0;
    for (const id of componentIds) {
      maxComponentScore = Math.max(maxComponentScore, scores.get(id) ?? 0);
    }
    if (maxComponentScore > 0) {
      for (const id of componentIds) {
        scores.set(id, ((scores.get(id) ?? 0) / maxComponentScore) * 10);
      }
    }
  }

  // Build results
  const totalActive = activeCourses.length;
  const results: RankingEntry[] = [];

  for (const id of activeCourses) {
    const count = compCounts.get(id) ?? 0;
    const opponents = uniqueOpponents.get(id)?.size ?? 0;
    // Confidence = fraction of other active courses compared against
    const confidence = totalActive > 1 ? opponents / (totalActive - 1) : 0;

    results.push({
      course_id: id,
      bt_score: round(scores.get(id) ?? 0, 4),
      rank: 0, // Set after sorting
      comparison_count: count,
      confidence: round(Math.min(1.0, confidence), 3),
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
