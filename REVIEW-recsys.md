# Recommender Systems Architecture Review

**Reviewer role**: Recommender Systems Architect
**Document under review**: ARCHITECTURE.md v2
**Review date**: 2026-03-02
**Verdict**: Strong foundation with 3 structural gaps that must be addressed before implementation, 2 that should be addressed before Phase 2, and 2 known tradeoffs that are acceptable for MVP.

---

## Summary

The architecture correctly identifies pairwise comparisons as a higher-fidelity
preference signal than star ratings. The choice of Bradley-Terry is sound. The
canonical pair constraint fix is critical and well-reasoned. The Phase 2 upgrade
path (BT with covariates) is the right destination.

However, I found **three structural decisions that will degrade recommendation
quality in ways that are expensive to fix later**, and **two missing data capture
opportunities that are cheap to add now but costly to retrofit**.

---

## FINDING 1: Comparison History Destruction (Severity: CRITICAL)

### The Problem

The schema enforces `UNIQUE(user_id, course_a_id, course_b_id)` and the API
uses `upsert` to update comparisons. This means when a user changes their mind
about A vs B, the old comparison is **overwritten**.

This destroys temporal preference signal.

### Why This Matters for Recommendations

Taste changes over time. A user who preferred parkland courses in 2025 but
shifted toward links courses by 2027 has a **preference trajectory**. This
trajectory is one of the most powerful signals in recommendation systems:

- **Preference drift detection**: "Your taste is evolving toward X" enables
  proactive recommendations of courses the user doesn't know they'd love yet.
- **Recency weighting**: A comparison made yesterday is more informative than
  one from 2 years ago. But if you overwrite, you can't distinguish them.
- **Confidence calibration**: If a user has flip-flopped on A vs B three times,
  that pair has LOW confidence regardless of comparison count. The current
  confidence metric can't detect this because it only sees the latest state.
- **Model training data**: BT with covariates learns β (taste weights) from
  comparisons. If β changes over time, you need the temporal sequence to
  learn a time-varying β. Overwritten data makes this impossible.

### Concrete Scenario

```
2025-03: User compares Pine Valley vs Shinnecock → picks Pine Valley
2026-01: User replays Shinnecock, it's been renovated, amazing
2026-02: User compares Pine Valley vs Shinnecock → picks Shinnecock
```

Current design: only the 2026 comparison exists. The system has no idea
the user changed their mind. It can't learn that Shinnecock's renovation
(conditioning attribute change) drove the preference shift.

### Fix

Remove the UNIQUE constraint on the pair. Allow multiple comparisons per
user per pair. Add a `superseded_by` or use a `is_active` flag so the
ranking engine uses only the latest comparison, but ALL comparisons are
retained for model training.

```sql
-- Remove: UNIQUE(user_id, course_a_id, course_b_id)
-- Add:
CREATE TABLE comparisons (
  ...
  is_active    BOOLEAN DEFAULT TRUE,
  -- When a new comparison for the same pair is inserted,
  -- a trigger sets is_active = FALSE on the previous one.
  ...
);
-- Ranking engine: WHERE is_active = TRUE
-- ML training pipeline: uses ALL rows, weighted by recency
```

Alternatively, keep the UNIQUE + upsert for the "active comparisons" table
(the ranking engine's input), but add a `comparison_history` append-only
log table that records every comparison event with timestamps. The history
table is the ML training data. The active table is the ranking input.

**Cost to add now**: ~30 minutes of schema work.
**Cost to retrofit later**: Every comparison made between now and the retrofit
is lost temporal data. Unrecoverable.

---

## FINDING 2: Implicit Signal Blindness (Severity: HIGH)

### The Problem

The architecture captures exactly one type of user action: explicit pairwise
comparisons. Every other user interaction is discarded.

### Signal Inventory

| User action | Signal value | Currently captured? |
|-------------|-------------|-------------------|
| Picks A over B in comparison | Explicit preference (highest quality) | YES |
| Time spent deciding (decided_in_ms) | Decision difficulty / preference closeness | YES |
| Searches for "links courses scotland" | Intent + attribute preference | **NO** |
| Views course detail page for 30 seconds | Interest / consideration | **NO** |
| Adds course to collection | Has played (binary) | YES |
| Searches for a course, sees it, doesn't add | Negative interest | **NO** |
| Adds course but never compares it | Low engagement | **NO** (detectable but not tracked) |
| Taps "Done" mid-session, skipping a presented pair | Pair difficulty / decision avoidance | **NO** |
| Removes a course from collection | Regret / taste change | **NO** (deletion is silent) |

In production recommendation systems, implicit signals routinely account for
**60-80% of usable training data** because they're generated at 10-100x the
volume of explicit signals and are free of social desirability bias.

### What This Means Concretely

A user with 25 courses and 80 comparisons has generated 80 explicit signals.
But in the process of making those 80 comparisons, they likely:
- Searched for courses ~40 times
- Viewed ~60 course detail pages
- Added 25 courses (25 implicit positive signals)
- Skipped 5 presented pairs
- Hesitated >5 seconds on 15 comparisons (strong closeness signal)

That's ~145 implicit signals thrown away, many of them recoverable with a
single `events` table.

### Fix

Add a lightweight event log table. Not for MVP UI — just for data capture.
Write to it from the client on key actions. Ignore it until Phase 2.

```sql
CREATE TABLE user_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  -- e.g., 'search', 'course_view', 'course_add', 'course_remove',
  --       'comparison_presented', 'comparison_skipped', 'session_end'
  payload    JSONB,
  -- e.g., {query: "links scotland"} or {course_id: "...", duration_ms: 3400}
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_user_events_user ON user_events(user_id);
CREATE INDEX idx_user_events_type ON user_events(event_type);
```

**Rules**:
- Append-only. Never update or delete.
- No RLS read access from client (write-only via insert policy). This is
  training data, not user-facing data.
- No MVP features depend on it. It's a data collection layer.
- Phase 2 ML pipeline reads it for feature engineering.

**Cost to add now**: 1 table, a few `supabase.from('user_events').insert()`
calls sprinkled into existing UI event handlers.
**Cost to retrofit later**: All implicit signals from launch to retrofit
are permanently lost. You can never recover what users searched for, which
course pages they lingered on, or which comparisons they skipped.

---

## FINDING 3: Attribute Coverage Dependency with No Enforcement (Severity: HIGH)

### The Problem

Section 9 states: "Course attributes must be populated — not optional NULLs."
Then marks this as ✅ because the schema has the columns.

But the schema uses `SMALLINT CHECK (... BETWEEN 1 AND 5)` with no `NOT NULL`
constraint. Every attribute column is implicitly nullable. The seed script
"must include attributes" but there's no enforcement. User-created courses
will have ALL attributes NULL (the add-course form collects only name, city,
state, course type).

### Why This Matters for Recommendations

BT with covariates learns `β · x_i` where `x_i` is the attribute vector.
If `x_i` has NULLs, you have three bad options:
1. **Drop the comparison from training**: Wastes explicit signal data.
2. **Impute with column mean**: Introduces bias (the course is "average" on
   every dimension, which is almost certainly wrong).
3. **Use a missing-indicator pattern**: Doubles the feature space and the model
   learns "missing walkability" as its own feature, which has no semantic meaning.

At 500 seeded courses with attributes and 200 user-added courses without
attributes, 29% of comparisons involving user-added courses have degraded
covariate vectors. That's not an edge case — it's a structural gap.

### The Deeper Issue

The 9 experience attributes are the entire foundation of the content-based
recommendation strategy. They ARE the feature space. If attribute coverage is
poor, the content-based recommender produces poor predictions, which means:
- Taste profiles (β vectors) are noisy
- Content-based recommendations are unreliable
- The system falls back entirely on collaborative filtering, which requires
  massive user overlap (Phase 3+)

### Fix (Two-Part)

**Part A — Seed data quality gate**: The seed script must enforce a minimum
attribute coverage. Define a threshold: every seeded course must have at
least 6 of 9 attributes populated. Courses below this threshold are imported
without attributes and flagged for manual review. This is a data pipeline
quality check, not a schema change.

**Part B — Attribute collection at play-time**: When a user adds a course to
their collection (marking "I've played this"), prompt for 3-4 key attributes
as part of the flow. Not all 9. Pick the ones with highest variance and
information value:

1. **Difficulty** (1-5) — high variance, strong taste differentiator
2. **Scenery** (1-5) — high variance, emotional driver
3. **Course type** (already captured) — categorical, high information
4. **Walkability** (1-5) — practical, easy to answer

Make these optional but encouraged ("Help improve recommendations").
Aggregate across users for consensus values. This solves the coverage
problem organically without forcing data entry.

---

## FINDING 4: JSONB Ranking Cache is an ML Anti-Pattern (Severity: MEDIUM)

### The Problem

`user_ranking_cache.rankings` stores rankings as a JSONB array:
`[{course_id, bt_score, rank, comparison_count, confidence}, ...]`

This is fine for client consumption but terrible for ML batch processing.

### Why This Matters

When the Phase 3 Python service needs to build a user-course score matrix
for collaborative filtering, it must:

```python
# What the service needs to do:
# Build matrix where rows=users, cols=courses, values=bt_scores

# With JSONB cache, for 10K users:
for user in all_users:
    rankings = json.loads(user.ranking_cache)  # parse JSONB
    for entry in rankings:
        matrix[user.id][entry['course_id']] = entry['bt_score']
# This is O(users × avg_courses) with JSON parsing overhead
```

Versus with denormalized rows:
```sql
SELECT user_id, course_id, bt_score
FROM user_rankings
ORDER BY user_id;
-- Single sequential scan, no parsing, directly into numpy/pandas
```

The JSONB approach is 10-50x slower for matrix construction at scale,
requires application-level parsing, and can't be indexed or queried
by course_id ("which users rank course X highest?").

### Fix

Keep the JSONB cache for client read performance (single row fetch is fast).
BUT also plan for a denormalized `user_rankings` view/table that the ML
pipeline can query efficiently. This can be:

- A materialized view refreshed by the same trigger/process that updates cache
- The original `user_rankings` table from v1 (one row per user-course pair)
  maintained alongside the JSONB cache
- Generated on-demand by the Python service from raw comparisons (acceptable
  if batch runs are infrequent)

For MVP: do nothing. Just document that the JSONB cache is NOT the ML data
source, and the Python service will recompute from raw comparisons.
This is fine because BT recomputation from comparisons for 10K users takes
<30 seconds in Python.

**Verdict**: Acceptable for MVP. Must be addressed before Phase 3 if user
count exceeds ~50K.

---

## FINDING 5: Binary Search Insertion Introduces Systematic Comparison Bias (Severity: MEDIUM)

### The Problem

Section 6 describes binary search insertion for new courses:
> Compare new course vs course ranked #12 (midpoint)
> If new > #12: compare vs #6
> ...

This is a great UX optimization. But it creates a structural bias in the
comparison graph.

### The Bias

Binary search insertion means a new course is ONLY compared against courses
near its "true" rank position. A course that lands at rank #15 is compared
against courses #8, #12, #14, #16 — never against course #1 or course #30.

This means:
- **Top-ranked and bottom-ranked courses are rarely compared against each other.**
  The system never validates that #1 is actually better than #25. It infers
  this transitively, which works in BT but produces LOW confidence on
  distant-rank comparisons.
- **The comparison graph is locally dense but globally sparse.** Lots of
  adjacent-rank comparisons, few cross-rank comparisons. This is exactly the
  structure that makes BT's transitivity assumption most vulnerable — if there
  IS an intransitive cycle, it's between distant ranks, and the system will
  never discover it.
- **For BT with covariates, cross-rank comparisons are the most informative.**
  Comparing a top-5 links course against a bottom-5 parkland course tells the
  model a LOT about attribute preferences. Comparing two mid-ranked parkland
  courses tells it very little.

### Fix

Don't eliminate binary search insertion — it's too good for UX. But add a
**periodic cross-rank comparison** to the pair selection algorithm. After
every ~5 binary-search-style comparisons, inject one comparison between
courses from different quartiles of the ranking.

In the pair selection algorithm (Section 5), add between Phase B and Phase C:

```
# Phase B.5: Cross-rank exploration (every 5th comparison in a session)
IF session_comparison_count % 5 == 0:
  top_quartile = courses ranked in top 25%
  bottom_quartile = courses ranked in bottom 25%
  RETURN (random from top_quartile, random from bottom_quartile)
```

This costs the user 2 comparisons per 10-comparison session (trivial UX cost)
and dramatically improves the global structure of the comparison graph.

---

## FINDING 6: No Preference Strength Signal (Severity: MEDIUM)

### The Problem

Every comparison produces a binary outcome: A wins or B wins. There is no
indication of preference strength.

"Pebble Beach is slightly better than Spyglass Hill" and "Pebble Beach is
vastly better than my local muni" produce identical data: one comparison
record with a winner.

### Why This Matters

Standard BT treats all comparisons equally. BT with covariates also treats
all comparisons equally (each is one observation in the likelihood function).
But preference STRENGTH carries information about attribute importance:

- A narrow preference between two similar courses → the differentiating
  attributes matter only slightly
- A strong preference between two dissimilar courses → the differentiating
  attributes matter a LOT

Without strength, the covariate model treats both situations identically,
which underweights the most informative comparisons.

### The `decided_in_ms` Proxy

The architecture already captures `decided_in_ms`. This is a reasonable
proxy for decision difficulty (inverse of preference strength): fast decisions
= strong preference, slow decisions = close call. Research supports this
correlation (response time as preference strength indicator, Krajbich et al. 2010).

### Fix

Do NOT add explicit strength input to the comparison UI (e.g., "how much
do you prefer A?"). This is asking the user to rate their rating, which is
exactly the kind of metacognitive overhead that makes star ratings unreliable.

Instead, leverage `decided_in_ms` as an implicit strength signal:
1. **MVP**: Capture `decided_in_ms` (already planned). No model use yet.
2. **Phase 2**: Convert `decided_in_ms` to a weight in BT computation.
   Weighted BT is a straightforward extension: comparisons with shorter
   decision times get higher weight (stronger preference signal).

   `weight_ij = 1 / (1 + log(decided_in_ms / baseline_ms))`

   where `baseline_ms` is the user's median decision time.

3. **Validation**: Compare weighted BT vs unweighted BT on held-out
   comparison prediction accuracy. If weighted doesn't improve, drop it.

**Verdict**: The current design handles this acceptably via `decided_in_ms`.
The only action item is documenting the Phase 2 weighting strategy so the
data capture requirement is clear.

---

## FINDING 7: Collaborative Filtering Sparsity Underestimated (Severity: LOW for MVP)

### The Problem

Section 9 proposes matrix factorization (ALS/SVD) on the user-course BT score
matrix. It claims BT scores provide "dense signal per user-course pair" which
is "much better input than binary played/not played data."

This is only half true. BT scores exist only for courses a user has played
AND compared. With ~500 seeded courses and users playing 20-50 each, the
user-course matrix is 90-96% sparse. This is standard sparsity for
recommendation systems and ALS/SVD can handle it — but the document
underestimates the challenge.

### The Real Issue

Sparsity isn't the problem — the **overlap problem** is. Collaborative
filtering works by finding users with similar preferences on shared courses
and then recommending each other's unshared courses. This requires sufficient
overlap: two users must have both played and ranked at least ~5-10 of the
same courses for similarity to be meaningful.

Golf course overlap is structurally LOW compared to restaurants or movies:
- Restaurants: users in the same city share 50%+ of the same restaurant pool
- Movies: blockbusters create massive overlap (80%+ of users have seen top 100)
- Golf courses: a user in Texas and a user in Maine might share 2-3 famous
  courses (Pebble Beach, Pinehurst, Bethpage Black) and nothing else

This means collaborative filtering will be WEAK until either:
a) User density is very high in specific regions (100+ users in same metro)
b) The "bucket list" famous courses create enough overlap (requires seeding
   those courses prominently and encouraging users to add them)

### Fix

Not a schema issue. But the recommendation strategy should:
1. Lead with content-based recommendations (BT with covariates) which work
   per-user without overlap
2. Use collaborative filtering only when overlap exceeds a minimum threshold
   (e.g., 8+ shared ranked courses between users)
3. Weight the hybrid model heavily toward content-based until collaborative
   signal is strong

This is a Phase 3 architecture decision, not an MVP action item. But it
changes the priority: **content-based quality (dependent on attribute coverage)
is more important than collaborative filtering infrastructure**.

Which loops back to Finding 3: attribute coverage is the bottleneck for
recommendation quality.

---

## Summary of Required Actions

### Must fix before implementation (data loss / structural)

| # | Finding | Action | Effort |
|---|---------|--------|--------|
| 1 | Comparison history destruction | Add comparison_history table or is_active flag | 1 hour |
| 2 | Implicit signal blindness | Add user_events append-only log table | 1 hour |
| 3 | Attribute coverage gap | Seed quality gate + optional attribute prompts on course-add | 2 hours |

### Should fix before Phase 2 (model quality)

| # | Finding | Action | Effort |
|---|---------|--------|--------|
| 5 | Binary search comparison bias | Add cross-rank pair injection to selection algorithm | 30 min |
| 6 | Preference strength | Document decided_in_ms → weight conversion for Phase 2 BT | Document only |

### Acceptable for MVP (known tradeoffs)

| # | Finding | Status |
|---|---------|--------|
| 4 | JSONB ranking cache | Recompute from raw comparisons in Phase 3; no MVP action |
| 7 | Collaborative filtering sparsity | Content-based takes priority; collab filtering is Phase 3+ |

---

## Overall Assessment

The architecture is **unusually well-reasoned for a pre-implementation design**.
The Bradley-Terry choice, canonical pair fix, client-side computation, and
binary search insertion are all correct. The Phase 2 upgrade path via BT
with covariates is the right destination.

The three must-fix items (comparison history, event log, attribute coverage)
are all cheap to add now and catastrophically expensive to retrofit. They
share a common theme: **the MVP's job is not just to ship a product, it's
to build a training dataset.** Every design decision should be evaluated
against "will this help the recommendation engine in 12 months?" — and these
three gaps are the places where the current design fails that test.

The comparison data is the moat. But a moat filled with undifferentiated
water (binary comparisons with no temporal history, no implicit signals,
and sparse attribute coverage) is a weaker moat than one filled with
rich, multi-signal, temporally-aware preference data.

Fix the three gaps, and this architecture is ready to build.
