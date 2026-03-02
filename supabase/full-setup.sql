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
-- Seed: golf courses with full attribute coverage
INSERT INTO courses (name, slug, city, state_province, country, architect, year_built, course_type, holes, par, walkability, scenery, conditioning, strategy_complexity, difficulty, architectural_interest, historical_significance, exclusivity, vibe, is_verified) VALUES
('Pine Valley Golf Club', 'pine-valley-golf-club-pine-valley-nj', 'Pine Valley', 'NJ', 'US', 'George Crump', 1913, 'parkland', 18, 70, 3, 5, 5, 5, 5, 5, 5, 5, 5, true),
('Augusta National Golf Club', 'augusta-national-golf-club-augusta-ga', 'Augusta', 'GA', 'US', 'Alister MacKenzie', 1933, 'parkland', 18, 72, 3, 5, 5, 5, 4, 5, 5, 5, 5, true),
('Cypress Point Club', 'cypress-point-club-pebble-beach-ca', 'Pebble Beach', 'CA', 'US', 'Alister MacKenzie', 1928, 'links', 18, 72, 3, 5, 5, 5, 4, 5, 5, 5, 5, true),
('Shinnecock Hills Golf Club', 'shinnecock-hills-golf-club-southampton-ny', 'Southampton', 'NY', 'US', 'William Flynn', 1891, 'links', 18, 70, 4, 5, 5, 5, 5, 5, 5, 5, 4, true),
('Pebble Beach Golf Links', 'pebble-beach-golf-links-pebble-beach-ca', 'Pebble Beach', 'CA', 'US', 'Jack Neville', 1919, 'links', 18, 72, 3, 5, 4, 4, 4, 5, 5, 2, 5, true),
('Oakmont Country Club', 'oakmont-country-club-oakmont-pa', 'Oakmont', 'PA', 'US', 'Henry Fownes', 1903, 'parkland', 18, 71, 4, 3, 5, 5, 5, 5, 5, 5, 3, true),
('Merion Golf Club (East)', 'merion-golf-club-east-ardmore-pa', 'Ardmore', 'PA', 'US', 'Hugh Wilson', 1912, 'parkland', 18, 70, 4, 4, 5, 5, 5, 5, 5, 5, 4, true),
('National Golf Links of America', 'national-golf-links-of-america-southampton-ny', 'Southampton', 'NY', 'US', 'Charles Blair Macdonald', 1911, 'links', 18, 73, 4, 5, 5, 5, 4, 5, 5, 5, 5, true),
('Sand Hills Golf Club', 'sand-hills-golf-club-mullen-ne', 'Mullen', 'NE', 'US', 'Bill Coore & Ben Crenshaw', 1995, 'links', 18, 71, 5, 5, 4, 4, 4, 5, 3, 5, 5, true),
('Fishers Island Club', 'fishers-island-club-fishers-island-ny', 'Fishers Island', 'NY', 'US', 'Seth Raynor', 1926, 'links', 18, 72, 4, 5, 4, 5, 4, 5, 4, 5, 5, true),
('Winged Foot Golf Club (West)', 'winged-foot-golf-club-west-mamaroneck-ny', 'Mamaroneck', 'NY', 'US', 'A.W. Tillinghast', 1923, 'parkland', 18, 72, 3, 4, 5, 5, 5, 5, 5, 5, 4, true),
('Pacific Dunes', 'pacific-dunes-bandon-or', 'Bandon', 'OR', 'US', 'Tom Doak', 2001, 'links', 18, 71, 4, 5, 4, 5, 4, 5, 3, 2, 5, true),
('Bandon Dunes', 'bandon-dunes-bandon-or', 'Bandon', 'OR', 'US', 'David McLay Kidd', 1999, 'links', 18, 72, 4, 5, 4, 4, 4, 4, 3, 2, 5, true),
('Bandon Trails', 'bandon-trails-bandon-or', 'Bandon', 'OR', 'US', 'Bill Coore & Ben Crenshaw', 2005, 'parkland', 18, 71, 3, 5, 4, 4, 4, 4, 2, 2, 4, true),
('Old Macdonald', 'old-macdonald-bandon-or', 'Bandon', 'OR', 'US', 'Tom Doak', 2010, 'links', 18, 71, 5, 4, 4, 4, 3, 5, 2, 2, 4, true),
('Sheep Ranch', 'sheep-ranch-bandon-or', 'Bandon', 'OR', 'US', 'Bill Coore & Ben Crenshaw', 2020, 'links', 18, 72, 4, 5, 4, 3, 3, 4, 1, 2, 5, true),
('Pinehurst No. 2', 'pinehurst-no-2-pinehurst-nc', 'Pinehurst', 'NC', 'US', 'Donald Ross', 1907, 'parkland', 18, 72, 5, 3, 5, 5, 5, 5, 5, 2, 4, true),
('Streamsong Red', 'streamsong-red-streamsong-fl', 'Streamsong', 'FL', 'US', 'Bill Coore & Ben Crenshaw', 2012, 'links', 18, 72, 4, 4, 4, 4, 4, 4, 1, 2, 4, true),
('Streamsong Blue', 'streamsong-blue-streamsong-fl', 'Streamsong', 'FL', 'US', 'Tom Doak', 2012, 'links', 18, 72, 4, 4, 4, 5, 4, 5, 1, 2, 4, true),
('Streamsong Black', 'streamsong-black-streamsong-fl', 'Streamsong', 'FL', 'US', 'Gil Hanse', 2017, 'links', 18, 73, 4, 4, 4, 4, 4, 4, 1, 2, 4, true),
('TPC Sawgrass (Stadium)', 'tpc-sawgrass-stadium-ponte-vedra-beach-fl', 'Ponte Vedra Beach', 'FL', 'US', 'Pete Dye', 1980, 'parkland', 18, 72, 3, 3, 5, 4, 4, 4, 4, 2, 3, true),
('Whistling Straits (Straits)', 'whistling-straits-straits-sheboygan-wi', 'Sheboygan', 'WI', 'US', 'Pete Dye', 1998, 'links', 18, 72, 2, 5, 5, 4, 5, 4, 3, 2, 4, true),
('Bethpage Black', 'bethpage-black-farmingdale-ny', 'Farmingdale', 'NY', 'US', 'A.W. Tillinghast', 1936, 'parkland', 18, 71, 2, 3, 4, 4, 5, 4, 4, 1, 3, true),
('Torrey Pines (South)', 'torrey-pines-south-la-jolla-ca', 'La Jolla', 'CA', 'US', 'William Bell', 1957, 'parkland', 18, 72, 2, 5, 4, 3, 4, 3, 3, 1, 4, true),
('Kiawah Island (Ocean Course)', 'kiawah-island-ocean-course-kiawah-island-sc', 'Kiawah Island', 'SC', 'US', 'Pete Dye', 1991, 'links', 18, 72, 3, 5, 4, 4, 5, 4, 4, 2, 5, true),
('Harbour Town Golf Links', 'harbour-town-golf-links-hilton-head-island-sc', 'Hilton Head Island', 'SC', 'US', 'Pete Dye', 1969, 'links', 18, 71, 4, 4, 4, 4, 4, 4, 4, 2, 4, true),
('Cabot Cliffs', 'cabot-cliffs-inverness-ns', 'Inverness', 'NS', 'CA', 'Bill Coore & Ben Crenshaw', 2015, 'links', 18, 72, 3, 5, 4, 4, 4, 5, 2, 3, 5, true),
('Cabot Links', 'cabot-links-inverness-ns', 'Inverness', 'NS', 'CA', 'Rod Whitman', 2012, 'links', 18, 70, 5, 5, 4, 3, 3, 4, 2, 3, 5, true),
('Crystal Downs Country Club', 'crystal-downs-country-club-frankfort-mi', 'Frankfort', 'MI', 'US', 'Alister MacKenzie', 1933, 'parkland', 18, 70, 3, 5, 4, 5, 4, 5, 4, 5, 5, true),
('Prairie Dunes Country Club', 'prairie-dunes-country-club-hutchinson-ks', 'Hutchinson', 'KS', 'US', 'Perry Maxwell', 1937, 'links', 18, 70, 4, 4, 4, 5, 4, 5, 4, 4, 4, true),
('Chambers Bay', 'chambers-bay-university-place-wa', 'University Place', 'WA', 'US', 'Robert Trent Jones Jr.', 2007, 'links', 18, 72, 2, 5, 3, 4, 4, 4, 2, 1, 4, true),
('Erin Hills', 'erin-hills-erin-wi', 'Erin', 'WI', 'US', 'Michael Hurdzan & Dana Fry', 2006, 'links', 18, 72, 3, 4, 4, 4, 5, 4, 2, 2, 4, true),
('Arcadia Bluffs', 'arcadia-bluffs-arcadia-mi', 'Arcadia', 'MI', 'US', 'Warren Henderson & Rick Smith', 1999, 'links', 18, 72, 3, 5, 4, 3, 4, 3, 1, 2, 4, true),
('Spyglass Hill Golf Course', 'spyglass-hill-golf-course-pebble-beach-ca', 'Pebble Beach', 'CA', 'US', 'Robert Trent Jones Sr.', 1966, 'parkland', 18, 72, 2, 5, 4, 4, 5, 4, 3, 2, 4, true),
('Shadow Creek', 'shadow-creek-north-las-vegas-nv', 'North Las Vegas', 'NV', 'US', 'Tom Fazio', 1990, 'desert', 18, 72, 3, 5, 5, 3, 3, 3, 2, 4, 5, true),
('We Ko Pa (Saguaro)', 'we-ko-pa-saguaro-fort-mcdowell-az', 'Fort McDowell', 'AZ', 'US', 'Bill Coore & Ben Crenshaw', 2006, 'desert', 18, 71, 3, 5, 4, 4, 4, 4, 1, 2, 4, true),
('TPC Scottsdale (Stadium)', 'tpc-scottsdale-stadium-scottsdale-az', 'Scottsdale', 'AZ', 'US', 'Tom Weiskopf & Jay Morrish', 1986, 'desert', 18, 71, 4, 4, 5, 3, 3, 3, 3, 2, 4, true),
('Tobacco Road Golf Club', 'tobacco-road-golf-club-sanford-nc', 'Sanford', 'NC', 'US', 'Mike Strantz', 1998, 'parkland', 18, 71, 3, 3, 3, 5, 5, 5, 2, 1, 4, true),
('Rustic Canyon Golf Course', 'rustic-canyon-golf-course-moorpark-ca', 'Moorpark', 'CA', 'US', 'Gil Hanse', 2002, 'links', 18, 72, 5, 3, 3, 4, 3, 4, 1, 1, 4, true),
('Sweetens Cove Golf Club', 'sweetens-cove-golf-club-south-pittsburg-tn', 'South Pittsburg', 'TN', 'US', 'Rob Collins & Tad King', 2014, 'parkland', 9, 36, 5, 3, 3, 4, 3, 5, 1, 3, 5, true),
('The Lido at Sand Valley', 'the-lido-at-sand-valley-nekoosa-wi', 'Nekoosa', 'WI', 'US', 'Tom Doak', 2023, 'links', 18, 72, 5, 4, 4, 5, 4, 5, 3, 3, 5, true),
('Sand Valley Golf Resort', 'sand-valley-golf-resort-nekoosa-wi', 'Nekoosa', 'WI', 'US', 'Bill Coore & Ben Crenshaw', 2017, 'links', 18, 71, 5, 4, 4, 4, 3, 4, 1, 3, 5, true),
('Mammoth Dunes', 'mammoth-dunes-nekoosa-wi', 'Nekoosa', 'WI', 'US', 'David McLay Kidd', 2018, 'links', 18, 73, 5, 4, 4, 3, 3, 4, 1, 3, 5, true),
('Sedge Valley', 'sedge-valley-nekoosa-wi', 'Nekoosa', 'WI', 'US', 'Tom Doak', 2024, 'links', 18, 72, 5, 4, 4, 4, 3, 4, 1, 3, 5, true),
('Ballyneal Golf Club', 'ballyneal-golf-club-holyoke-co', 'Holyoke', 'CO', 'US', 'Tom Doak', 2006, 'links', 18, 72, 4, 4, 4, 5, 4, 5, 2, 4, 5, true),
('Gamble Sands', 'gamble-sands-brewster-wa', 'Brewster', 'WA', 'US', 'David McLay Kidd', 2014, 'links', 18, 72, 4, 5, 4, 3, 3, 4, 1, 2, 5, true),
('Bandon Preserve', 'bandon-preserve-bandon-or', 'Bandon', 'OR', 'US', 'Bill Coore & Ben Crenshaw', 2012, 'links', 13, 46, 5, 5, 4, 3, 2, 4, 1, 2, 5, true),
('Pasatiempo Golf Club', 'pasatiempo-golf-club-santa-cruz-ca', 'Santa Cruz', 'CA', 'US', 'Alister MacKenzie', 1929, 'parkland', 18, 71, 2, 4, 4, 5, 4, 5, 4, 1, 4, true),
('Barnbougle Dunes', 'barnbougle-dunes-bridport-tas', 'Bridport', 'TAS', 'AU', 'Tom Doak', 2004, 'links', 18, 71, 5, 5, 4, 4, 4, 5, 2, 2, 5, true)
ON CONFLICT (slug) DO NOTHING;
