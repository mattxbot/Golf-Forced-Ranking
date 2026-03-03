-- Fix UPDATE RLS policies: add WITH CHECK clauses to prevent
-- users from reassigning ownership of rows to other users.
--
-- Without WITH CHECK, a user could UPDATE a row's user_id to
-- another user's ID, effectively transferring ownership.

-- Comparisons: prevent reassigning user_id on update
DROP POLICY IF EXISTS "Users can update own comparisons" ON comparisons;
CREATE POLICY "Users can update own comparisons"
  ON comparisons FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- User courses: prevent reassigning user_id on update
DROP POLICY IF EXISTS "Users can update own courses" ON user_courses;
CREATE POLICY "Users can update own courses"
  ON user_courses FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Ranking cache: prevent reassigning user_id on update
DROP POLICY IF EXISTS "Users can update own ranking cache" ON user_ranking_cache;
CREATE POLICY "Users can update own ranking cache"
  ON user_ranking_cache FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Profiles: prevent reassigning id on update
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Courses: enforce created_by on insert
DROP POLICY IF EXISTS "Authenticated users can add courses" ON courses;
CREATE POLICY "Authenticated users can add courses"
  ON courses FOR INSERT
  WITH CHECK (auth.uid() = created_by);
