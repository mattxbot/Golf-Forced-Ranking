# Golf Forced Ranking — Architecture Design

## Decision Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Platform | Next.js (mobile-first PWA) | Fastest iteration, no app store friction, Capacitor escape hatch |
| Backend | Supabase (Postgres + Auth + Edge Functions) | Managed infra, RLS, realtime — ship fast, eject later |
| Social scope | Solo-first | Reduce MVP surface area; social is Phase 2+ |
| Course data | Hybrid (seeded + user-added) | Best UX — most courses findable, gaps filled organically |

---

## 1. High-Level System Architecture

```
┌─────────────────────────────────────┐
│         Next.js App (Vercel)        │
│  ┌───────────┐  ┌────────────────┐  │
│  │  App Router│  │ Tailwind + UI  │  │
│  │  (RSC +    │  │ (shadcn/ui)    │  │
│  │  Client)   │  │                │  │
│  └─────┬──────┘  └────────────────┘  │
│        │                             │
│  ┌─────▼──────────────────────────┐  │
│  │  Supabase Client SDK           │  │
│  │  (Auth + Realtime + PostgREST) │  │
│  └─────┬──────────────────────────┘  │
│        │                             │
│  ┌─────▼──────────────────────────┐  │
│  │  Bradley-Terry Engine          │  │
│  │  (client-side TypeScript)      │  │
│  └────────────────────────────────┘  │
└────────┼────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│          Supabase Platform          │
│  ┌──────────┐  ┌─────────────────┐  │
│  │ Auth      │  │ Edge Functions  │  │
│  │ (email +  │  │ (batch rerank,  │  │
│  │  OAuth)   │  │  course import) │  │
│  └──────────┘  └─────────────────┘  │
│  ┌──────────────────────────────────│
│  │ PostgreSQL                       │
│  │  - courses, comparisons, ranks   │
│  │  - Row-Level Security            │
│  │  - DB triggers for rank dirty    │
│  │    flag + cascade validation      │
│  └──────────────────────────────────│
└─────────────────────────────────────┘
         │
         ▼  (Phase 3+)
┌─────────────────────────────────────┐
│  Python Recommendation Service      │
│  (FastAPI + scikit-learn)           │
│  - BT with covariates (taste model) │
│  - collaborative filtering          │
│  - content similarity               │
│  - connects directly to Postgres    │
└─────────────────────────────────────┘
```

### Architecture Change from v1: Ranking Compute Location

The original design placed Bradley-Terry computation in a Supabase Edge Function.
This is wrong for MVP. Here's why:

- A user with 30 courses and 80 comparisons generates a BT recalc payload of ~5KB.
  Running this in an Edge Function means: network round trip on every comparison,
  cold start latency (200-500ms on Supabase Deno), and the user sees a spinner
  after every A-vs-B tap.

- BT for <200 courses converges in <1ms in JavaScript. There is no reason
  to leave the client.

**Revised approach**:
- **Client-side**: BT engine runs in the browser as a pure TypeScript module.
  After each comparison, recalculate locally and update UI instantly.
- **Server-side**: Persist the raw comparison. An async write-behind to
  `user_rankings` happens via a Supabase DB trigger or periodic Edge Function
  (for caching / offline recovery). The server ranking is the fallback, not
  the primary compute path.
- **Phase 3**: When we add collaborative filtering, rankings are batch-recomputed
  server-side by the Python service (BT with covariates across all users).

This gives instant feedback with zero network latency on comparisons.

### Why This Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Framework | Next.js 14+ (App Router) | RSC for fast initial loads, client components for interactive ranking UI, API routes as escape hatch |
| Styling | Tailwind CSS + shadcn/ui | Component primitives without vendor lock-in, mobile-first by default |
| Database | Supabase Postgres | Managed, RLS for multi-tenant security, PostgREST auto-generates API, realtime for live rank updates |
| Auth | Supabase Auth | Zero-config email + OAuth, JWT-based, integrates with RLS |
| Ranking compute | Client-side TypeScript | <1ms for user-scale data, instant UX, no cold start; server is write-behind cache |
| Deployment | Vercel | Instant deploys, preview URLs, edge network, native Next.js support |
| Future ML | Python sidecar | scipy/scikit-learn ecosystem for recommendations; connects to same Postgres |

---

## 2. Ranking Algorithm: Bradley-Terry Model

### Evaluated Options

#### Elo Rating System
- **How it works**: Each course has a rating. After a comparison, the winner gains points and the loser drops, with magnitude based on the upset factor.
- **Pros**: Simple, incremental, well-understood.
- **Cons**: Order-dependent — entering the same comparisons in different order produces different scores. Designed for serial games, not batch preference elicitation. K-factor tuning is fragile.
- **Verdict**: Workable but not principled for this use case.

#### TrueSkill
- **How it works**: Bayesian model maintaining mean (μ) and uncertainty (σ) per item. Updates via message passing.
- **Pros**: Handles uncertainty, converges fast with few comparisons.
- **Cons**: Complex implementation (factor graphs), originally designed for multiplayer matchmaking. Overkill for simple A-vs-B choices.
- **Verdict**: Good but over-engineered for MVP.

#### Pairwise Ranking Graph (Topological Sort)
- **How it works**: Build a directed graph of preferences, derive ordering via topological sort.
- **Pros**: No information loss, intuitive.
- **Cons**: Cycles break the model. Doesn't produce a numerical score (critical for recommendations). Doesn't handle incomplete comparisons well.
- **Verdict**: Too brittle. Fails the moment a user has non-transitive preferences.

#### Bradley-Terry Model ← CHOSEN
- **How it works**: Maximum likelihood estimation of latent "quality" parameters from pairwise comparison data. P(A > B) = θ_A / (θ_A + θ_B).
- **Pros**:
  - Statistically principled probability model
  - Handles sparse/incomplete comparisons naturally
  - Order-independent (unlike Elo)
  - Produces real-valued scores that feed directly into recommendation vectors
  - Simple iterative algorithm (~30 lines)
  - Well-studied with known convergence guarantees
- **Cons**: Assumes transitivity (if A > B and B > C, implies A > C). See risk analysis below.
- **Verdict**: Best fit. Principled, simple, recommendation-compatible.

### Algorithm Detail

```
INPUT:  Set of comparisons [(winner, loser), ...]
OUTPUT: Score per course (higher = more preferred)

1. Initialize all scores to 1.0
2. Repeat until convergence (or fixed iterations, max 20):
   For each course i:
     w_i = number of times i won a comparison
     d_i = Σ over all j compared against i: 1 / (score_i + score_j)
     score_i = w_i / d_i
3. Normalize scores (e.g., sum to N or max to 100)
4. Rank by descending score
```

**Properties**:
- Converges in 5-10 iterations for typical user data (<200 courses)
- Computation is O(C × I) where C = comparisons, I = iterations
- For 50 courses and 200 comparisons: <1ms in browser JS
- Deterministic: same comparisons always produce same scores

### Transitivity Assumption: Honest Risk Assessment

Bradley-Terry assumes if you prefer A > B and B > C, you also prefer A > C.
For golf courses, this **will** be violated. Example:

> User loves links courses AND mountain courses but dislikes parkland.
> Links course A > Parkland course B (links > parkland)
> Parkland course B > Mountain course C (conditioning matters here)
> Mountain course C > Links course A (that specific mountain course is special)

**Why this is acceptable for MVP**: Intransitive cycles in real user data are
rare (typically <5% of triads) and indicate genuine ambivalence. BT handles
them gracefully — it finds the best-fit linear ordering that minimizes
disagreement with observed comparisons. The user won't notice a problem
unless they explicitly check for cycles.

**Why this matters for Phase 2+**: When we upgrade to BT with covariates
(see Section 9), the model explains WHY preferences exist via course
attributes. This resolves most "apparent" intransitivities because the model
can learn "user values walkability highly but also values scenery" — the
multi-dimensional preference becomes explicit rather than collapsed to a
single score.

### Confidence Metric

Confidence per course = `min(1.0, comparisons_involving_course / ceil(log2(total_courses)) )`

Rationale: a binary-search insertion into N items requires ~log2(N) comparisons.
A course that has been compared log2(N) times has been "placed" with reasonable
confidence. This is more principled than the v1 formula (which required comparing
against every other course for confidence 1.0 — unrealistic at 30+ courses).

### Cold Start Strategy

| User's comparison count | Ranking strategy |
|------------------------|------------------|
| 0 comparisons | No ranking shown. Prompt: "Add courses and start comparing" |
| 1-4 comparisons | Simple win-count ordering. Label: "Early ranking — compare more for accuracy" |
| 5+ comparisons | Full Bradley-Terry. Show confidence per course |

BT MLE requires every course to have at least one comparison to produce a
finite score. Courses with 0 comparisons get a default score of 0.5
(below any compared course) and are visually distinguished.

---

## 3. Database Schema (MVP)

### Entity Relationship

```
profiles 1──∞ user_courses ∞──1 courses
profiles 1──∞ comparisons
courses  1──∞ comparisons (as course_a or course_b)
profiles 1──1 user_ranking_cache
```

### CRITICAL FIX: Comparison Table Uniqueness

**Bug in v1 schema**: The original design used `UNIQUE(user_id, winner_course_id, loser_course_id)`.
This allows BOTH `(user=1, winner=A, loser=B)` AND `(user=1, winner=B, loser=A)` to exist
simultaneously — contradictory data.

**Fix**: Store comparisons as canonical unordered pairs with a separate winner column.
`course_a_id` is always the lesser UUID (lexicographic). The `winner` column indicates
which course won.

```
comparisons
  user_id + course_a_id + course_b_id  → UNIQUE
  course_a_id < course_b_id            → CHECK constraint
  winner = 'a' | 'b'                   → which course won
```

This guarantees exactly one comparison record per user per course pair. Updating
a comparison (user changes their mind) is an UPDATE, not a conflicting INSERT.

### Tables

```sql
-- ============================================================
-- Extensions
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- Core tables
-- ============================================================

-- Extends Supabase auth.users
CREATE TABLE profiles (
  id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username     TEXT UNIQUE NOT NULL,
  display_name TEXT,
  avatar_url   TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

-- Golf courses (seeded + user-contributed)
CREATE TABLE courses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  -- Slug includes city to avoid collisions ("the-links-st-andrews" vs "the-links-fargo")
  slug            TEXT UNIQUE NOT NULL,
  city            TEXT,
  state_province  TEXT,
  country         TEXT DEFAULT 'US',
  latitude        NUMERIC(9,6),
  longitude       NUMERIC(9,6),
  architect       TEXT,
  year_built      SMALLINT,
  course_type     TEXT CHECK (course_type IN (
                    'links','parkland','desert','mountain','resort','municipal','private'
                  )),
  holes           SMALLINT DEFAULT 18,
  par             SMALLINT,
  website_url     TEXT,
  image_url       TEXT,
  -- Experience attributes (1-5 scale, NULL = not yet rated)
  -- These are "consensus" values (editorial or community-averaged).
  -- Per-user attribute perception is Phase 2 (user_course_attributes table).
  walkability            SMALLINT CHECK (walkability BETWEEN 1 AND 5),
  scenery                SMALLINT CHECK (scenery BETWEEN 1 AND 5),
  conditioning           SMALLINT CHECK (conditioning BETWEEN 1 AND 5),
  strategy_complexity    SMALLINT CHECK (strategy_complexity BETWEEN 1 AND 5),
  difficulty             SMALLINT CHECK (difficulty BETWEEN 1 AND 5),
  architectural_interest SMALLINT CHECK (architectural_interest BETWEEN 1 AND 5),
  historical_significance SMALLINT CHECK (historical_significance BETWEEN 1 AND 5),
  exclusivity            SMALLINT CHECK (exclusivity BETWEEN 1 AND 5),
  vibe                   SMALLINT CHECK (vibe BETWEEN 1 AND 5),
  -- Metadata
  is_verified     BOOLEAN DEFAULT FALSE,
  created_by      UUID REFERENCES profiles(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Courses a user has played
CREATE TABLE user_courses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course_id   UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  date_played DATE,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, course_id)
);

-- ============================================================
-- Comparison system (RecSys Review Fix #1: temporal history)
-- ============================================================

-- Active comparisons: one per user per canonical pair.
-- This is the ranking engine's input.
-- Canonical form: course_a_id < course_b_id (lexicographic UUID order).
CREATE TABLE comparisons (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course_a_id   UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  course_b_id   UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  winner        TEXT NOT NULL CHECK (winner IN ('a', 'b')),
  decided_in_ms INTEGER,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, course_a_id, course_b_id),
  CHECK (course_a_id < course_b_id)
);

-- Append-only comparison history: every comparison ever made.
-- Retained for: preference drift detection, recency weighting, flip-flop
-- confidence, and temporal BT model training in Phase 2+.
-- When a user changes A vs B, the new result goes into both tables:
-- `comparisons` is upserted (ranking input), `comparison_history` is appended.
CREATE TABLE comparison_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course_a_id   UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  course_b_id   UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  winner        TEXT NOT NULL CHECK (winner IN ('a', 'b')),
  decided_in_ms INTEGER,
  created_at    TIMESTAMPTZ DEFAULT now(),
  CHECK (course_a_id < course_b_id)
);

-- ============================================================
-- Implicit signal capture (RecSys Review Fix #2: event log)
-- ============================================================

-- Append-only event log for implicit signals.
-- Write-only from client (insert RLS only). Never read in MVP.
-- Phase 2 ML pipeline reads for feature engineering.
CREATE TABLE user_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  -- Event types: 'search_query', 'course_view', 'course_add',
  --   'course_remove', 'comparison_presented', 'comparison_skipped',
  --   'comparison_completed', 'session_start', 'session_end'
  payload    JSONB DEFAULT '{}',
  -- e.g. {query: "links scotland"}, {course_id: "...", duration_ms: 3400},
  --      {course_a_id: "...", course_b_id: "...", skipped: true}
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- Ranking cache
-- ============================================================

-- Cached ranking output (write-behind from client-side BT computation).
-- This is a CACHE, not source of truth. Fully regenerable from comparisons.
CREATE TABLE user_ranking_cache (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID UNIQUE NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- JSONB array: [{course_id, bt_score, rank, comparison_count, confidence}, ...]
  rankings     JSONB NOT NULL DEFAULT '[]',
  -- Dirty flag: set TRUE by DB trigger when comparisons change.
  is_stale     BOOLEAN DEFAULT TRUE,
  computed_at  TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- Indexes
-- ============================================================

CREATE INDEX idx_user_courses_user ON user_courses(user_id);
CREATE INDEX idx_comparisons_user ON comparisons(user_id);
CREATE INDEX idx_comparisons_courses ON comparisons(course_a_id, course_b_id);
CREATE INDEX idx_comparison_history_user ON comparison_history(user_id);
CREATE INDEX idx_comparison_history_time ON comparison_history(user_id, created_at);
CREATE INDEX idx_user_events_user ON user_events(user_id);
CREATE INDEX idx_user_events_type ON user_events(event_type);
CREATE INDEX idx_courses_slug ON courses(slug);
CREATE INDEX idx_courses_name_trgm ON courses USING gin(name gin_trgm_ops);

-- ============================================================
-- Triggers
-- ============================================================

-- 1. Auto-append to comparison_history on every comparison insert/update
CREATE OR REPLACE FUNCTION append_comparison_history()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO comparison_history (user_id, course_a_id, course_b_id, winner, decided_in_ms)
  VALUES (NEW.user_id, NEW.course_a_id, NEW.course_b_id, NEW.winner, NEW.decided_in_ms);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_comparison_append_history
AFTER INSERT OR UPDATE ON comparisons
FOR EACH ROW EXECUTE FUNCTION append_comparison_history();

-- 2. Mark ranking cache as stale when comparisons change
CREATE OR REPLACE FUNCTION mark_rankings_stale()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO user_ranking_cache (user_id, is_stale)
  VALUES (COALESCE(NEW.user_id, OLD.user_id), TRUE)
  ON CONFLICT (user_id)
  DO UPDATE SET is_stale = TRUE, updated_at = now();
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_comparisons_stale_cache
AFTER INSERT OR UPDATE OR DELETE ON comparisons
FOR EACH ROW EXECUTE FUNCTION mark_rankings_stale();
```

### Schema Change Summary (v1 → v2 → v3)

| Change | Version | Why |
|--------|---------|-----|
| Comparison uniqueness: canonical pair + winner column | v2 | **Data integrity bug fix.** v1 allowed contradictory records |
| `decided_in_ms` on comparisons | v2 | **Data quality signal.** Speed-tap detection, Phase 2 BT weighting |
| `user_ranking_cache` replaces `user_rankings` | v2 | **Architectural alignment.** Client-side compute, server is cache |
| Slug includes city context | v2 | **Dedup correctness.** Same-name courses in different cities |
| DB trigger for stale flag | v2 | **Consistency guarantee.** Client knows when to recompute |
| `comparison_history` append-only table | v3 | **RecSys Fix #1.** Preserves temporal signal for preference drift, recency weighting, flip-flop detection |
| `user_events` append-only log | v3 | **RecSys Fix #2.** Captures implicit signals (search, views, skips) for Phase 2 ML |
| Auto-append trigger on comparisons | v3 | **Consistency.** Every comparison write automatically logs to history |
| Cross-rank pair injection in selection algo | v3 | **RecSys Fix #5.** Prevents locally-dense/globally-sparse comparison graphs |

### Row-Level Security Policy Summary

| Table | SELECT | INSERT | UPDATE | DELETE |
|-------|--------|--------|--------|--------|
| profiles | Own row | On signup trigger | Own row | Own row |
| courses | All (public read) | Authenticated | Own created + unverified | None |
| user_courses | Own rows | Own rows | Own rows | Own rows |
| comparisons | Own rows | Own rows | Own rows | Own rows |
| comparison_history | None (ML only) | Via trigger only | None | None |
| user_events | None (ML only) | Own rows (write-only) | None | None |
| user_ranking_cache | Own row | Own row (upsert) | Own row | None |

### Course Deduplication Strategy

Duplicate courses are poison for collaborative filtering (Phase 3). Two entries
for "Pebble Beach" means users who both played it might not be recognized as
having overlapping taste.

**MVP approach**:
1. Seed data uses canonical source (avoids duplicates at import time)
2. User-added courses go through fuzzy match check: search existing courses
   by name + state before allowing creation. UI shows "Did you mean...?" with
   existing matches before allowing "Add new"
3. `is_verified = FALSE` for all user-created courses. Admin review queue (manual
   for MVP, automated later) merges duplicates

**Phase 2**: Automated dedup via Postgres `similarity()` function on name + city
pairs, surfacing merge candidates to admin.

---

## 4. API Surface (Phase 1)

All data access goes through Supabase client SDK (PostgREST) except ranking computation
(which is client-side).

### Client SDK Operations (PostgREST)

```
Auth
  supabase.auth.signUp()           — email + password
  supabase.auth.signInWithPassword() — email + password
  supabase.auth.signOut()
  supabase.auth.signInWithOAuth()  — Google, Apple

Courses
  supabase.from('courses').select().ilike('name', '%query%')      — search
  supabase.from('courses').select().eq('id', id)                  — detail
  supabase.from('courses').insert({...})                          — add new

User Courses
  supabase.from('user_courses').select('*, courses(*)').eq('user_id', me)  — my collection
  supabase.from('user_courses').insert({user_id, course_id})               — add to collection
  supabase.from('user_courses').delete().eq('id', id)                      — remove

Comparisons
  supabase.from('comparisons').select().eq('user_id', me)                  — all my comparisons
  supabase.from('comparisons').upsert({...}, {onConflict: 'user_id,course_a_id,course_b_id'})
    — insert or update a comparison (canonical pair + winner)
  supabase.from('comparisons').delete().eq('id', id)                       — remove

Ranking Cache
  supabase.from('user_ranking_cache').select().eq('user_id', me).single()  — get cached ranking
  supabase.from('user_ranking_cache').upsert({user_id, rankings, is_stale: false})
    — persist client-computed ranking
```

### Ranking Computation Flow

```
1. User taps "A" in comparison
2. Client: upsert comparison to DB (fire-and-forget)
3. Client: add comparison to local state
4. Client: run BT algorithm on full comparison set (<1ms)
5. Client: update ranked list in UI (instant)
6. Client: persist ranking cache to DB (debounced, 2s delay)
7. DB trigger: marks cache as stale (but client already has fresh data)
8. On next app load: check is_stale flag → recompute if needed
```

No Edge Functions needed for Phase 1. This is simpler and faster.

---

## 5. Pair Selection Algorithm (Critical UX)

### Why This Matters

A user with 30 courses has 435 possible pairs. Comparing all of them is
unrealistic. The pair selection algorithm determines:
- How many comparisons are needed for a stable ranking
- Whether the ranking "feels right" to the user quickly
- The quality of data for future recommendations

### Strategy: Adaptive Swiss-Tournament with Uncertainty Targeting

```
FUNCTION select_next_pair(courses, comparisons, rankings, session_index):

  # Phase A: Bootstrap (no ranking exists yet)
  IF comparison_count < course_count:
    # Ensure every course appears in at least one comparison.
    # Pick a course with 0 comparisons, pair with a random course.
    uncompared = courses with 0 comparisons
    IF uncompared is not empty:
      RETURN (random from uncompared, random from rest)

  # Phase B: Cross-rank exploration (every 5th comparison in session)
  # [RecSys Review Fix #5] Binary search insertion creates locally-dense,
  # globally-sparse comparison graphs. Cross-rank comparisons validate
  # transitivity and provide high-information signal for covariate learning.
  IF session_index % 5 == 4 AND course_count >= 8:
    top_quarter = courses ranked in top 25%
    bottom_quarter = courses ranked in bottom 25%
    RETURN (random from top_quarter, random from bottom_quarter)

  # Phase C: Boundary refinement
  # Find adjacent pairs in current ranking that haven't been compared.
  # These comparisons have the highest information value: they resolve
  # whether the ranking order is correct at each boundary.
  sorted = courses sorted by BT score descending
  FOR i in 0..len(sorted)-2:
    pair = (sorted[i], sorted[i+1])
    IF pair not in comparisons:
      RETURN pair

  # Phase D: Confidence fill
  # Pick the pair with lowest combined confidence.
  # Breaks ties randomly to avoid predictable patterns.
  lowest_confidence_pair = pair not yet compared with
    min(confidence[a] + confidence[b])
  IF lowest_confidence_pair exists:
    RETURN lowest_confidence_pair

  # Phase E: Re-evaluation
  # All pairs compared. Pick oldest comparison for re-evaluation.
  RETURN pair with oldest comparison timestamp
```

**Expected comparison count for stable ranking**:
- N courses → ~N×log2(N) comparisons for high confidence
- 20 courses → ~87 comparisons (not 190 for full pairwise)
- 50 courses → ~282 comparisons (not 1,225)

### Comparison Session Design

Don't present an endless stream. Users do comparisons in **sessions**:
- Default session: 10 comparisons (adjustable)
- After 10: "Nice! Your ranking is X% confident. Keep going or done for now?"
- Visual progress bar showing ranking confidence improvement per session

---

## 6. MVP UI Flows (Phase 1)

### Screen Map

```
Onboarding
  [1] Sign Up / Log In
  [2] "Add courses you've played" (search + select, minimum 3)
  [3] "Let's rank them" → first comparison session (10 pairs)
  [4] → My Rankings (home)

Main App (bottom tab navigation)
  [A] Rankings (home tab)
      — Ordered list: rank #, course name, location, confidence dot
      — Low-confidence courses have a subtle "compare more" affordance
      — FAB: "Compare" → comparison session

  [B] Compare (full-screen modal from FAB)
      — Two course cards stacked vertically (mobile-first)
      — "Which do you prefer?" header
      — Tap to choose → card animates out → next pair slides in
      — Progress: "4 of 10" + session confidence gain
      — Top-right: "Done" to exit early

  [C] My Courses (tab)
      — List of played courses (not ranked — just collection)
      — Search + add new
      — Tap to see detail
      — Swipe left to remove (with confirmation if comparisons exist)

  [D] Course Detail (pushed from Rankings or My Courses)
      — Course info: name, location, type, architect, year
      — Attributes (visual bar/dot display)
      — Your rank: "#4 of 23 courses" with confidence
      — "Compare against..." action to target-compare

  [E] Add Course (modal from My Courses)
      — Search existing DB first (fuzzy match)
      — Results show with "Add" button
      — "Can't find it?" → minimal form: name, city, state, course type
      — After adding → "Where does it rank?" → targeted comparison session
        (binary search: 5 comparisons to place among 30 courses)

  [F] Profile (tab)
      — Username, avatar
      — Stats: courses played, comparisons made, avg confidence
      — Settings, logout
```

### "Add Course" Insertion via Binary Search Comparisons

When a user adds their 25th course, don't make them do 24 comparisons.
Use binary search:

```
1. Compare new course vs course ranked #12 (midpoint)
2. If new > #12: compare vs #6 (midpoint of top half)
3. If new < #6: compare vs #9
4. Continue until position is found
5. ~5 comparisons to place 1 course among 30
```

This is the single most important UX optimization. It makes adding a course
feel lightweight (5 taps) instead of exhausting (24 taps).

---

## 7. Phase 1 Build Roadmap

### Milestone 1 — Project Foundation
- Next.js 14 project with App Router + TypeScript
- Tailwind CSS + shadcn/ui setup
- Supabase project + client configuration + environment variables
- Database schema migration (all tables, indexes, triggers, RLS above)
- Auth flow: signup, login, logout, protected route middleware
- Mobile-first layout shell (bottom tab nav, header)
- Seed script: import top ~500 US golf courses with attributes

### Milestone 2 — Course Management
- Course search (full-text via pg_trgm, debounced input)
- Course detail page
- "Add to my courses" flow with dedup check ("Did you mean...?")
- My Courses collection view
- Add new course form (name, city, state, course type)
- Remove course from collection (cascade-aware: warn if comparisons exist)

### Milestone 3 — Comparison Engine (core product)
- Bradley-Terry TypeScript module (pure function, no side effects)
- Comparison UI (two-card vertical layout, tap to choose)
- Canonical pair normalization (course_a < course_b)
- Comparison persistence (upsert to Supabase)
- Pair selection algorithm (bootstrap → boundary → confidence → re-eval)
- Comparison session flow (10-pair batches, progress, early exit)
- Binary search insertion for newly added courses

### Milestone 4 — Rankings Display
- Ranked list view (home screen, sorted by BT score)
- Confidence indicators per course (dot color: red/yellow/green)
- Overall ranking confidence percentage
- Rank change indicators (arrows showing movement since last session)
- Empty states: 0 courses, <3 courses, no comparisons yet
- First-use onboarding flow (add → compare → see ranking)

### Milestone 5 — Polish + PWA
- PWA manifest + service worker (offline read of rankings)
- Optimistic UI updates (comparison recorded before server confirms)
- Loading skeletons + error boundaries
- Ranking cache sync (write-behind, stale detection on load)
- Mobile touch: smooth card transitions in comparison flow
- Basic metrics logging (comparisons per session, session duration)

---

## 8. Key Technical Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Bradley-Terry doesn't converge with <5 comparisons | Medium | Fall back to win-count ordering; label ranking as "early" |
| Course deduplication failures poison future collaborative filtering | **High** | Fuzzy match on add, admin merge queue, verified flag |
| Users abandon comparison flow (fatigue) | **High** | Session-based (10 pairs), binary search insertion (~5 for new course), progress feedback, "done for now" always available |
| Speed-tapping produces low-quality comparisons | Medium | Track `decided_in_ms`; in Phase 2, down-weight comparisons <500ms in BT computation |
| Client-side BT computation diverges from server cache | Low | Cache is explicitly a cache (stale flag); client is source of truth; recompute from raw comparisons on any mismatch |
| Supabase free tier limits (500MB DB, 50K monthly active users) | Low | Comparison data is tiny (~100 bytes/row); 10K users × 200 comparisons = 200MB. Won't hit limits in MVP |
| Slug collisions for same-named courses in different cities | Medium | Slug format: `{name}-{city}-{state}` slugified. Uniqueness enforced at DB level |

---

## 9. Phase 2+ Upgrade Path: Bradley-Terry with Covariates

This section exists because **the most important thing Phase 1 must get right
is collecting the right data for Phase 2 recommendations**. The schema is
designed with this upgrade in mind.

### How BT with Covariates Works

Standard BT: `θ_i = exp(u_i)` where u_i is a course-specific parameter.

BT with covariates: `θ_i = exp(β · x_i + u_i)` where:
- `x_i` = attribute vector of course i (walkability, scenery, difficulty, ...)
- `β` = **user-specific preference weights** (learned from their comparisons)
- `u_i` = course-specific residual (what attributes don't explain)

**What this gives us**:
1. **Taste profile**: β is literally the user's taste — "values scenery 3x more than difficulty"
2. **Prediction for unplayed courses**: Given a course's attributes, predict user's preference without any comparisons
3. **Content-based recommendations**: Find courses whose attributes maximize β · x
4. **User similarity**: Compare β vectors between users for collaborative filtering

### What Phase 1 Must Get Right for This to Work

1. **Course attributes must be populated** — not optional NULLs. Seed data
   must include attributes. Attributes need to be structured integers (1-5),
   not free text. ✅ Already in schema.

2. **Comparisons must be stored as raw pairs** — not aggregated into scores.
   The BT-with-covariates algorithm needs raw comparison data to learn β.
   ✅ Already in schema (comparisons table stores every pair).

3. **Course attributes on the courses table are "consensus" values** — in Phase 2,
   we add `user_course_attributes` for per-user perception ("I found this course
   harder than most people"). This is NOT in the MVP schema but the schema
   accommodates it without migration.

### Recommendation Strategy (Phase 3)

| Method | Input | Output | Strength |
|--------|-------|--------|----------|
| Content-based (BT w/ covariates) | User's β + course attributes | Predicted preference score for unplayed courses | Works with 1 user, no cold start |
| Collaborative filtering | Comparison overlap between users | "Users similar to you also loved..." | Discovers non-obvious courses |
| Hybrid | Weighted combination | Final recommendation list | Best accuracy |

**Algorithm choice for collaborative filtering**: Matrix factorization on the
user-course BT score matrix (ALS or SVD). Not nearest-neighbor — too slow at
scale and too sensitive to sparsity. The BT scores give us a dense signal per
user-course pair, which is much better input to matrix factorization than
binary "played/not played" data.

This is the data moat: every comparison a user makes improves both their own
taste profile AND the collaborative signal for all users. No competitor can
replicate this without the comparison data.
