-- Shared Rankings — public snapshots of user rankings
-- Allows users to share a read-only view of their current rankings.

CREATE TABLE shared_rankings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  username          TEXT NOT NULL,
  rankings          JSONB NOT NULL,
  confidence        INTEGER NOT NULL,
  course_count      INTEGER NOT NULL,
  comparison_count  INTEGER NOT NULL,
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- Index for cleanup queries (e.g., purge old shares)
CREATE INDEX idx_shared_rankings_created_at ON shared_rankings(created_at);

-- Index for user lookups (rate-limit checks, "my shares")
CREATE INDEX idx_shared_rankings_user ON shared_rankings(user_id);

-- ============================================================
-- Row-Level Security
-- ============================================================

ALTER TABLE shared_rankings ENABLE ROW LEVEL SECURITY;

-- Anyone can read shared rankings (they are public by design)
CREATE POLICY "Shared rankings are publicly readable"
  ON shared_rankings FOR SELECT USING (true);

-- Only the owner can create shared rankings
CREATE POLICY "Users can create own shared rankings"
  ON shared_rankings FOR INSERT WITH CHECK (auth.uid() = user_id);
