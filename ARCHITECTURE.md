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
└────────┼────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│          Supabase Platform          │
│  ┌──────────┐  ┌─────────────────┐  │
│  │ Auth      │  │ Edge Functions  │  │
│  │ (email +  │  │ (ranking calc,  │  │
│  │  OAuth)   │  │  course import) │  │
│  └──────────┘  └─────────────────┘  │
│  ┌──────────────────────────────────│
│  │ PostgreSQL                       │
│  │  - courses, comparisons, ranks   │
│  │  - Row-Level Security            │
│  │  - pg_cron for batch jobs        │
│  └──────────────────────────────────│
└─────────────────────────────────────┘
         │
         ▼  (Phase 3+)
┌─────────────────────────────────────┐
│  Python Recommendation Service      │
│  (FastAPI + scikit-learn)           │
│  - collaborative filtering          │
│  - content similarity               │
│  - connects directly to Postgres    │
└─────────────────────────────────────┘
```

### Why This Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Framework | Next.js 14+ (App Router) | RSC for fast initial loads, client components for interactive ranking UI, API routes as escape hatch |
| Styling | Tailwind CSS + shadcn/ui | Component primitives without vendor lock-in, mobile-first by default |
| Database | Supabase Postgres | Managed, RLS for multi-tenant security, PostgREST auto-generates API, realtime for live rank updates |
| Auth | Supabase Auth | Zero-config email + OAuth, JWT-based, integrates with RLS |
| Ranking compute | Edge Function (Deno) | Bradley-Terry recalc triggered by comparison inserts; keeps client thin |
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
- **Cons**: Assumes transitivity (if A > B and B > C, implies A > C). Acceptable — true preference cycles are rare and indicate genuine ambivalence.
- **Verdict**: Best fit. Principled, simple, recommendation-compatible.

### Algorithm Detail

```
INPUT:  Set of comparisons [(winner, loser), ...]
OUTPUT: Score per course (higher = more preferred)

1. Initialize all scores to 1.0
2. Repeat until convergence (or fixed iterations):
   For each course i:
     w_i = number of times i won a comparison
     d_i = Σ over all j compared against i: 1 / (score_i + score_j)
     score_i = w_i / d_i
3. Normalize scores (e.g., sum to N or max to 100)
4. Rank by descending score
```

**Properties**:
- Converges in 5-10 iterations for typical user data (<200 courses)
- Computation is O(C) per iteration where C = number of comparisons
- For 50 courses and 200 comparisons: <1ms on any device
- Can run client-side for instant feedback, then persist server-side

### Confidence Metric

Confidence per course = `comparisons_involving_course / (2 * (total_courses - 1))`

A course compared against every other course once has confidence 1.0. A course with only 1 comparison has low confidence. This surfaces in the UI to encourage more comparisons.

---

## 3. Database Schema (MVP)

### Entity Relationship

```
profiles 1──∞ user_courses ∞──1 courses
profiles 1──∞ comparisons
courses  1──∞ comparisons (as winner)
courses  1──∞ comparisons (as loser)
profiles 1──∞ user_rankings ∞──1 courses
```

### Tables

```sql
-- Extends Supabase auth.users
CREATE TABLE profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username    TEXT UNIQUE NOT NULL,
  display_name TEXT,
  avatar_url  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Golf courses (seeded + user-contributed)
CREATE TABLE courses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
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
  -- Experience attributes (1-5 scale, NULL = unrated)
  walkability           SMALLINT CHECK (walkability BETWEEN 1 AND 5),
  scenery               SMALLINT CHECK (scenery BETWEEN 1 AND 5),
  conditioning          SMALLINT CHECK (conditioning BETWEEN 1 AND 5),
  strategy_complexity   SMALLINT CHECK (strategy_complexity BETWEEN 1 AND 5),
  difficulty            SMALLINT CHECK (difficulty BETWEEN 1 AND 5),
  architectural_interest SMALLINT CHECK (architectural_interest BETWEEN 1 AND 5),
  historical_significance SMALLINT CHECK (historical_significance BETWEEN 1 AND 5),
  exclusivity           SMALLINT CHECK (exclusivity BETWEEN 1 AND 5),
  vibe                  SMALLINT CHECK (vibe BETWEEN 1 AND 5),
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

-- Raw pairwise comparisons (source of truth)
CREATE TABLE comparisons (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  winner_course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  loser_course_id  UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, winner_course_id, loser_course_id),
  CHECK (winner_course_id != loser_course_id)
);

-- Computed rankings (materialized from Bradley-Terry)
CREATE TABLE user_rankings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course_id        UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  bt_score         NUMERIC(10,6) NOT NULL DEFAULT 1.0,
  rank_position    INTEGER NOT NULL DEFAULT 0,
  comparison_count INTEGER NOT NULL DEFAULT 0,
  confidence       NUMERIC(4,3) NOT NULL DEFAULT 0.0,
  updated_at       TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, course_id)
);

-- Indexes
CREATE INDEX idx_user_courses_user ON user_courses(user_id);
CREATE INDEX idx_comparisons_user ON comparisons(user_id);
CREATE INDEX idx_comparisons_winner ON comparisons(winner_course_id);
CREATE INDEX idx_comparisons_loser ON comparisons(loser_course_id);
CREATE INDEX idx_user_rankings_user_rank ON user_rankings(user_id, rank_position);
CREATE INDEX idx_courses_slug ON courses(slug);
CREATE INDEX idx_courses_name_trgm ON courses USING gin(name gin_trgm_ops);
```

### Row-Level Security Policy Summary

| Table | SELECT | INSERT | UPDATE | DELETE |
|-------|--------|--------|--------|--------|
| profiles | Own row | On signup trigger | Own row | Own row |
| courses | All (public) | Authenticated | Own created + unverified | None |
| user_courses | Own rows | Own rows | Own rows | Own rows |
| comparisons | Own rows | Own rows | Own rows | Own rows |
| user_rankings | Own rows | System only (edge fn) | System only | System only |

---

## 4. API Surface (Phase 1)

All data access goes through Supabase client SDK (PostgREST) except ranking computation.

### Client SDK Operations (PostgREST)

```
Auth
  POST   /auth/signup          — email + password
  POST   /auth/login           — email + password
  POST   /auth/logout
  POST   /auth/oauth/{provider} — Google, Apple

Courses
  GET    courses?name=ilike.*{query}*  — search courses
  GET    courses?id=eq.{id}            — course detail
  POST   courses                        — add new course

User Courses
  GET    user_courses?user_id=eq.{me}&select=*,courses(*)  — my collection
  POST   user_courses                   — add course to collection
  DELETE user_courses?id=eq.{id}        — remove from collection

Comparisons
  GET    comparisons?user_id=eq.{me}    — all my comparisons
  POST   comparisons                     — record a comparison
  PATCH  comparisons?id=eq.{id}         — change a comparison result
  DELETE comparisons?id=eq.{id}         — remove a comparison

Rankings
  GET    user_rankings?user_id=eq.{me}&order=rank_position  — my ranked list
```

### Edge Functions

```
POST /functions/v1/recalculate-rankings
  — Triggered after comparison insert/update/delete
  — Fetches all comparisons for user
  — Runs Bradley-Terry algorithm
  — Upserts user_rankings table
  — Returns new ranked list

POST /functions/v1/suggest-comparison
  — Returns the most informative next pair to compare
  — Strategy: pick the pair with fewest comparisons
    and highest uncertainty (lowest confidence)
```

---

## 5. MVP UI Flows (Phase 1)

### Screen Map

```
Onboarding
  [1] Sign Up / Log In
  [2] "Add courses you've played" (search + add)
  [3] "Let's rank them" → first comparison

Main App
  [A] My Rankings (home)
      — Ordered list with rank #, BT score, confidence
      — Tap course → detail
      — "Compare" FAB → comparison flow

  [B] Compare
      — Two course cards side by side
      — "Which do you prefer?"
      — Tap to choose → animate → next pair
      — Progress indicator (comparisons done / suggested)
      — "Done for now" exit

  [C] My Courses (collection)
      — Grid/list of played courses
      — Search + add new
      — Swipe to remove

  [D] Course Detail
      — Name, location, attributes
      — User's rank position + score
      — Comparison history for this course

  [E] Add Course
      — Search existing database
      — "Can't find it? Add new"
      — Minimal form: name, location, course type

  [F] Profile
      — Username, avatar
      — Stats: courses played, comparisons made, ranking depth
      — Settings, logout
```

### Comparison Flow Logic

When user taps "Compare":
1. System selects an optimal pair (most informative):
   - Priority 1: Courses with 0 comparisons
   - Priority 2: Adjacent courses in current ranking with low confidence
   - Priority 3: Random pair not yet compared
2. Present A vs B
3. User taps preferred course
4. Store comparison → trigger BT recalculation
5. Show updated rank positions with animation
6. Present next pair (or celebrate if all high-confidence)

---

## 6. Phase 1 Build Roadmap

### Milestone 1 — Project Foundation
- Next.js 14 project with App Router
- Tailwind CSS + shadcn/ui setup
- Supabase project + client configuration
- Database schema migration (all tables above)
- Auth flow: signup, login, logout, protected routes
- Mobile-first layout shell (bottom nav, header)
- Seed script: import top ~500 US golf courses

### Milestone 2 — Course Management
- Course search (full-text via pg_trgm)
- Course detail page
- "Add to my courses" flow
- My Courses collection view
- Add new course form (for missing courses)
- Remove course from collection

### Milestone 3 — Comparison Engine (core)
- Comparison UI (A vs B card selection)
- Store comparison to database
- Bradley-Terry computation (Edge Function)
- Pair selection algorithm (most informative next pair)
- Comparison session flow (sequential pairs)

### Milestone 4 — Rankings Display
- Ranked list view (home screen)
- Rank position + confidence indicators
- Rank change animations
- Course detail showing rank context
- Empty states + first-use onboarding

### Milestone 5 — Polish + PWA
- PWA manifest + service worker
- Offline indicator
- Loading states + optimistic updates
- Error handling
- Mobile gesture support (swipe comparisons)
- Basic analytics (comparison count, ranking depth)

---

## 7. Future Phases (Out of Scope for Phase 1)

### Phase 2 — Taste Modeling
- Compute user preference vectors from BT scores × course attributes
- Attribute affinity scores ("you love links courses with high walkability")
- Taste profile visualization

### Phase 3 — Recommendations
- Content-based: recommend courses with attributes matching user's preference vector
- Collaborative filtering: users with similar rankings → similar taste → recommend their top courses
- Hybrid model combining both signals
- Python microservice with scikit-learn

### Phase 4 — Social
- Follow other users
- Taste similarity scores between users
- Shared rankings / debates
- Course reviews with ranking context

---

## 8. Key Technical Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Bradley-Terry doesn't converge with very few comparisons (<3) | Fall back to simple win-count ordering until 5+ comparisons exist |
| Course search is slow without good data | Seed with quality dataset; use pg_trgm for fuzzy matching |
| Users abandon comparison flow (too many pairs) | Smart pair selection minimizes comparisons needed; "done for now" exit always available |
| Supabase Edge Functions cold start | Keep functions small; consider client-side BT calc as fallback |
| PWA limitations on iOS | Minimal reliance on push notifications; core UX works without native features |
