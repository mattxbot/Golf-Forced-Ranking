-- Performance indexes for common query patterns.

-- Comparisons ordered by update time (for re-evaluation phase in pair selection)
CREATE INDEX IF NOT EXISTS idx_comparisons_user_updated
  ON comparisons(user_id, updated_at DESC);

-- Ranking cache lookup by user + algorithm version (for cache hit validation)
CREATE INDEX IF NOT EXISTS idx_ranking_cache_user_version
  ON user_ranking_cache(user_id, algorithm_version);

-- Events by user + type + time (for ML pipeline aggregation)
CREATE INDEX IF NOT EXISTS idx_user_events_user_type_created
  ON user_events(user_id, event_type, created_at DESC);
