-- Add algorithm_version to ranking cache so we can invalidate stale caches
-- when the BT algorithm changes.
ALTER TABLE user_ranking_cache
  ADD COLUMN IF NOT EXISTS algorithm_version integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN user_ranking_cache.algorithm_version IS
  'Version of the Bradley-Terry algorithm that produced these rankings';
