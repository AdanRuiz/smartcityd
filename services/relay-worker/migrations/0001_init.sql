-- docs/spec/07, "Esquema D1".
CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  pubkey      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  kind        INTEGER NOT NULL,
  d           TEXT,                 -- only addressable (and replaceable, as '')
  city        TEXT,                 -- value of tag c (or d if kind = 31480)
  tags        TEXT NOT NULL,        -- JSON
  content     TEXT NOT NULL,
  sig         TEXT NOT NULL,
  expires_at  INTEGER,
  received_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX events_kind_time   ON events (kind, created_at DESC);
CREATE INDEX events_city_time   ON events (city, created_at);
CREATE INDEX events_city_recv   ON events (city, received_at, id);
CREATE UNIQUE INDEX events_addr ON events (kind, pubkey, d) WHERE d IS NOT NULL;

CREATE TABLE tags (
  name        TEXT NOT NULL,        -- one letter
  value       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  kind        INTEGER NOT NULL,
  event_id    TEXT NOT NULL,
  PRIMARY KEY (name, value, created_at, event_id)
) WITHOUT ROWID;
