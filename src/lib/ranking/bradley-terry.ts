/**
 * Bradley-Terry ranking engine (v3).
 *
 * Computes latent quality scores from pairwise comparison data via
 * maximum likelihood estimation. Pure function, no side effects.
 *
 * Algorithm: iterative MLE (MM algorithm for BT model)
 *   θ_i = w_i / Σ_j [n_ij / (θ_i + θ_j)]
 * where w_i = total wins for item i, n_ij = total comparisons between i and j.
 *
 * v3 changes over v2:
 * - Improved confidence metric: weighted by sqrt(comparison_count) per opponent
 * - Deterministic tie-breaking: confidence > comparison_count > course_id
 * - Convergence metadata returned via computeRankingsDetailed()
 *
 * Reference: Hunter, 2004. "MM algorithms for generalized Bradley-Terry models."
 */

import type { RankingEntry } from "@/types/database";

export interface ComparisonInput {
  course_a_id: string;
  course_b_id: string;
  winner: "a" | "b";
}

export interface RankingComputeResult {
  rankings: RankingEntry[];
  converged: boolean;
  iterations: number;
  maxDelta: number;
}

export const ALGORITHM_VERSION = 3;
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
 * Compute Bradley-Terry rankings with full convergence metadata.
 */
export function computeRankingsDetailed(
  courseIds: string[],
  comparisons: ComparisonInput[]
): RankingComputeResult {
  if (courseIds.length === 0) {
    return { rankings: [], converged: true, iterations: 0, maxDelta: 0 };
  }
  if (courseIds.length === 1) {
    return {
      rankings: [
        {
          course_id: courseIds[0],
          bt_score: 1.0,
          rank: 1,
          comparison_count: 0,
          confidence: 0,
        },
      ],
      converged: true,
      iterations: 0,
      maxDelta: 0,
    };
  }

  const courseSet = new Set(courseIds);

  // Filter to relevant comparisons
  const relevantComps = comparisons.filter(
    (c) => courseSet.has(c.course_a_id) && courseSet.has(c.course_b_id)
  );

  // Build win counts, comparison counts, and per-opponent comparison counts
  const wins = new Map<string, number>();
  const compCounts = new Map<string, number>();
  const opponentCounts = new Map<string, Map<string, number>>();

  for (const id of courseIds) {
    wins.set(id, 0);
    compCounts.set(id, 0);
    opponentCounts.set(id, new Map());
  }

  // Asymmetric edge map: only store (min_id, max_id) to prevent double-counting.
  const edgeMap = new Map<string, number>();

  for (const comp of relevantComps) {
    const winnerId = comp.winner === "a" ? comp.course_a_id : comp.course_b_id;

    wins.set(winnerId, (wins.get(winnerId) ?? 0) + 1);
    compCounts.set(comp.course_a_id, (compCounts.get(comp.course_a_id) ?? 0) + 1);
    compCounts.set(comp.course_b_id, (compCounts.get(comp.course_b_id) ?? 0) + 1);

    // Track per-opponent comparison counts
    const aOpps = opponentCounts.get(comp.course_a_id)!;
    aOpps.set(comp.course_b_id, (aOpps.get(comp.course_b_id) ?? 0) + 1);
    const bOpps = opponentCounts.get(comp.course_b_id)!;
    bOpps.set(comp.course_a_id, (bOpps.get(comp.course_a_id) ?? 0) + 1);

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
  const smoothedWins = new Map<string, number>();
  for (const id of activeCourses) {
    smoothedWins.set(id, wins.get(id) ?? 0);
  }
  const smoothedEdgeMap = new Map<string, number>();
  for (const [key, count] of edgeMap) {
    smoothedEdgeMap.set(key, count + 2 * LAPLACE_PSEUDO_COUNT);
    const [idA, idB] = key.split(":");
    smoothedWins.set(idA, (smoothedWins.get(idA) ?? 0) + LAPLACE_PSEUDO_COUNT);
    smoothedWins.set(idB, (smoothedWins.get(idB) ?? 0) + LAPLACE_PSEUDO_COUNT);
  }

  // Run BT-MLE independently per connected component
  const scores = new Map<string, number>();
  let globalConverged = true;
  let totalIterations = 0;
  let globalMaxDelta = 0;

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
    let componentConverged = false;
    let componentIter = 0;
    let maxDelta = 0;

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      maxDelta = 0;
      componentIter = iter + 1;

      for (const i of componentIds) {
        const w_i = smoothedWins.get(i) ?? 0;

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

      if (maxDelta < CONVERGENCE_THRESHOLD) {
        componentConverged = true;
        break;
      }
    }

    if (!componentConverged) globalConverged = false;
    totalIterations = Math.max(totalIterations, componentIter);
    globalMaxDelta = Math.max(globalMaxDelta, maxDelta);

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

  // Build results with improved confidence metric
  const totalActive = activeCourses.length;
  const results: RankingEntry[] = [];

  for (const id of activeCourses) {
    const count = compCounts.get(id) ?? 0;
    const oppMap = opponentCounts.get(id) ?? new Map();

    // Improved confidence: weighted by sqrt(comparisons per opponent)
    // This rewards both breadth (many opponents) and depth (repeat comparisons)
    // while diminishing returns from repeatedly comparing the same pair.
    let weightedCoverage = 0;
    for (const [, compCount] of oppMap) {
      weightedCoverage += Math.sqrt(compCount);
    }
    // Normalize: perfect = compared to every other active course sqrt(3) times each
    const maxPossible =
      totalActive > 1 ? Math.sqrt(3) * (totalActive - 1) : 1;
    const confidence = totalActive > 1
      ? Math.min(1.0, weightedCoverage / maxPossible)
      : 0;

    results.push({
      course_id: id,
      bt_score: round(scores.get(id) ?? 0, 4),
      rank: 0,
      comparison_count: count,
      confidence: round(confidence, 3),
    });
  }

  // Sort by BT score with deterministic tie-breaking
  results.sort((a, b) => {
    const scoreDiff = b.bt_score - a.bt_score;
    if (Math.abs(scoreDiff) > 0.0001) return scoreDiff;
    // Tie-break 1: higher confidence first
    const confDiff = b.confidence - a.confidence;
    if (Math.abs(confDiff) > 0.001) return confDiff;
    // Tie-break 2: more comparisons first
    if (a.comparison_count !== b.comparison_count) {
      return b.comparison_count - a.comparison_count;
    }
    // Tie-break 3: lexicographic course_id for full determinism
    return a.course_id.localeCompare(b.course_id);
  });

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

  return {
    rankings: results,
    converged: globalConverged,
    iterations: totalIterations,
    maxDelta: round(globalMaxDelta, 12),
  };
}

/**
 * Compute Bradley-Terry rankings from pairwise comparisons.
 * Convenience wrapper that returns just the rankings array.
 */
export function computeRankings(
  courseIds: string[],
  comparisons: ComparisonInput[]
): RankingEntry[] {
  return computeRankingsDetailed(courseIds, comparisons).rankings;
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
