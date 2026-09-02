-- PT Exercise App — SQLite schema
-- See docs/SYSTEM_DESIGN.md for rationale behind these constraints.

CREATE TABLE exercises (
  id TEXT PRIMARY KEY,              -- uuid (custom) or stable slug (bundled)
  source TEXT NOT NULL,             -- 'bundled' | 'custom'
  name TEXT NOT NULL,
  instructions TEXT NOT NULL,
  image_ref TEXT NOT NULL,          -- bundled: bundle-relative key; custom: filename in docDir
  default_sets INTEGER,
  default_reps INTEGER,
  default_duration_sec INTEGER,
  created_at TEXT                   -- custom only, NULL for bundled
);

CREATE TABLE routines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE routine_steps (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL REFERENCES exercises(id) ON DELETE RESTRICT,
  step_order INTEGER NOT NULL,
  sets INTEGER NOT NULL,
  reps INTEGER,
  duration_sec INTEGER,
  rest_sec INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE session_logs (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  steps_completed INTEGER NOT NULL DEFAULT 0,
  total_steps INTEGER NOT NULL
);

CREATE INDEX idx_routine_steps_routine ON routine_steps(routine_id);
CREATE INDEX idx_routine_steps_exercise ON routine_steps(exercise_id);
CREATE INDEX idx_session_logs_routine ON session_logs(routine_id);
