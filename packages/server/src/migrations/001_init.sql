-- 001_init: Phase 1-2 schema. Kept Postgres-portable: TEXT uuids, ISO-8601
-- UTC timestamps in TEXT, JSON in TEXT, CHECK constraints for enums.

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

CREATE TABLE workers (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  os                 TEXT NOT NULL CHECK (os IN ('darwin','win32','linux')),
  capabilities       TEXT NOT NULL DEFAULT '[]',
  status             TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online','offline')),
  load               TEXT,
  last_heartbeat_at  TEXT,
  created_at         TEXT NOT NULL
);

CREATE TABLE devices (
  id             TEXT PRIMARY KEY,                       -- <workerId>:<platform>:<deviceKey>
  worker_id      TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  platform       TEXT NOT NULL CHECK (platform IN ('ios','android')),
  device_key     TEXT NOT NULL,
  serial         TEXT,
  name           TEXT NOT NULL,
  model          TEXT NOT NULL,
  os_version     TEXT NOT NULL,
  screen_w       INTEGER,
  screen_h       INTEGER,
  screen_density REAL,
  state          TEXT NOT NULL CHECK (state IN ('booted','shutdown','booting','unknown')),
  connected      INTEGER NOT NULL DEFAULT 1,              -- 0 when its worker is offline or it disappeared
  last_seen_at   TEXT NOT NULL,
  UNIQUE (worker_id, platform, device_key)
);
CREATE INDEX idx_devices_platform ON devices(platform);

CREATE TABLE device_leases (
  device_id    TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  holder       TEXT NOT NULL,                             -- 'task:<id>' or 'manual:<actor>'
  task_id      TEXT,
  acquired_at  TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX idx_leases_expires ON device_leases(expires_at);

CREATE TABLE builds (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  name        TEXT NOT NULL,
  platform    TEXT NOT NULL CHECK (platform IN ('ios','android')),
  app_id      TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_builds_platform ON builds(platform, created_at);

CREATE TABLE build_installs (
  id          TEXT PRIMARY KEY,
  build_id    TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('pending','installing','installed','failed')),
  error       TEXT,
  updated_at  TEXT NOT NULL,
  UNIQUE (build_id, device_id)
);

CREATE TABLE test_suites (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  name        TEXT NOT NULL,
  flow_yaml   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE test_runs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  suite_id     TEXT NOT NULL REFERENCES test_suites(id),
  mode         TEXT NOT NULL DEFAULT 'shared' CHECK (mode IN ('shared','agent')),
  status       TEXT NOT NULL CHECK (status IN ('queued','running','passed','failed','error','cancelled')),
  env          TEXT NOT NULL DEFAULT '{}',
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  finished_at  TEXT
);
CREATE INDEX idx_runs_created ON test_runs(created_at);

CREATE TABLE test_tasks (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  device_id    TEXT NOT NULL REFERENCES devices(id),
  build_id     TEXT REFERENCES builds(id),
  status       TEXT NOT NULL CHECK (status IN ('queued','leasing','preparing','running','passed','failed','error','cancelled')),
  attempt      INTEGER NOT NULL DEFAULT 1,
  error        TEXT,
  started_at   TEXT,
  finished_at  TEXT,
  duration_ms  INTEGER,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_tasks_run ON test_tasks(run_id);
CREATE INDEX idx_tasks_status ON test_tasks(status);

CREATE TABLE artifacts (
  id          TEXT PRIMARY KEY,
  run_id      TEXT REFERENCES test_runs(id) ON DELETE CASCADE,
  task_id     TEXT REFERENCES test_tasks(id) ON DELETE CASCADE,
  device_id   TEXT REFERENCES devices(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('screenshot','junit','log','maestro-output')),
  file_path   TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_artifacts_task ON artifacts(task_id);
CREATE INDEX idx_artifacts_run ON artifacts(run_id);

CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT,
  detail  TEXT,
  at      TEXT NOT NULL
);
CREATE INDEX idx_audit_at ON audit_log(at);
