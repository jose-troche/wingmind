-- apps/edge/migrations/0001_init.sql
CREATE TABLE sorties (
  id          TEXT PRIMARY KEY,
  player      TEXT NOT NULL,              -- anonymous id kept in the browser, no accounts
  created_at  INTEGER NOT NULL,
  scenario_id TEXT NOT NULL,
  duration_s  INTEGER NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN ('survived', 'shot_down', 'crashed', 'aborted')),
  metrics     TEXT NOT NULL,              -- JSON: envelope minutes, detected minutes, reaction p50, false alarms, fuel at landing
  debrief     TEXT,
  replay_key  TEXT                        -- R2 object key
);
CREATE INDEX idx_sorties_player ON sorties(player, created_at DESC);

CREATE TABLE personal_bests (
  player      TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  score       REAL NOT NULL,
  sortie_id   TEXT NOT NULL,
  PRIMARY KEY (player, scenario_id)
);
