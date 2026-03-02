-- Golf Forced Ranking — Initial Schema
-- Incorporates all fixes from RecSys architecture review (v3).

-- ============================================================
-- Extensions
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- Core tables
-- ============================================================

-- Extends Supabase auth.users with profile data
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
  -- Experience attributes (1-5 scale). NULL = not yet rated.
  -- These are consensus values (editorial or community-averaged).
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
-- Comparison system
-- Active comparisons: one per user per canonical pair (ranking input).
-- History: append-only log of all comparisons (ML training data).
-- ============================================================

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

-- [RecSys Review Fix #1] Append-only comparison history.
-- Preserves temporal signal: preference drift, recency weighting,
-- flip-flop confidence. Auto-populated by trigger on comparisons.
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
-- Implicit signal capture [RecSys Review Fix #2]
-- ============================================================

-- Append-only event log. Write-only from client. Never read in MVP.
-- Phase 2 ML pipeline reads for feature engineering.
CREATE TABLE user_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload    JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- Ranking cache
-- ============================================================

CREATE TABLE user_ranking_cache (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID UNIQUE NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  rankings     JSONB NOT NULL DEFAULT '[]',
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

-- 1. Auto-append to comparison_history on every comparison write
CREATE OR REPLACE FUNCTION append_comparison_history()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO comparison_history (
    user_id, course_a_id, course_b_id, winner, decided_in_ms
  ) VALUES (
    NEW.user_id, NEW.course_a_id, NEW.course_b_id, NEW.winner, NEW.decided_in_ms
  );
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

-- 3. Auto-create profile on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, username, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'username', 'user_' || substr(NEW.id::text, 1, 8)),
    COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.raw_user_meta_data->>'full_name'),
    NEW.raw_user_meta_data->>'avatar_url'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ============================================================
-- Row-Level Security
-- ============================================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE comparisons ENABLE ROW LEVEL SECURITY;
ALTER TABLE comparison_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_ranking_cache ENABLE ROW LEVEL SECURITY;

-- Profiles: users can read/update their own profile
CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE USING (auth.uid() = id);

-- Courses: public read, authenticated insert, owner update on unverified
CREATE POLICY "Courses are publicly readable"
  ON courses FOR SELECT USING (true);
CREATE POLICY "Authenticated users can add courses"
  ON courses FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Owners can update unverified courses"
  ON courses FOR UPDATE USING (
    auth.uid() = created_by AND is_verified = false
  );

-- User courses: full CRUD on own rows
CREATE POLICY "Users can view own courses"
  ON user_courses FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can add courses"
  ON user_courses FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own courses"
  ON user_courses FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can remove own courses"
  ON user_courses FOR DELETE USING (auth.uid() = user_id);

-- Comparisons: full CRUD on own rows
CREATE POLICY "Users can view own comparisons"
  ON comparisons FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can add comparisons"
  ON comparisons FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own comparisons"
  ON comparisons FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own comparisons"
  ON comparisons FOR DELETE USING (auth.uid() = user_id);

-- Comparison history: no client read (ML pipeline uses service role)
CREATE POLICY "No client reads on comparison_history"
  ON comparison_history FOR SELECT USING (false);
-- Inserts happen via trigger (SECURITY DEFINER function), not client.

-- User events: write-only from client
CREATE POLICY "No client reads on user_events"
  ON user_events FOR SELECT USING (false);
CREATE POLICY "Users can log own events"
  ON user_events FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Ranking cache: own row read/write
CREATE POLICY "Users can view own ranking cache"
  ON user_ranking_cache FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can upsert own ranking cache"
  ON user_ranking_cache FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own ranking cache"
  ON user_ranking_cache FOR UPDATE USING (auth.uid() = user_id);
