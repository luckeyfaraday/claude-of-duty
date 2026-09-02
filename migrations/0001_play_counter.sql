CREATE TABLE IF NOT EXISTS play_totals (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  players INTEGER NOT NULL DEFAULT 0 CHECK (players >= 0),
  plays INTEGER NOT NULL DEFAULT 0 CHECK (plays >= players)
);

INSERT OR IGNORE INTO play_totals (id, players, plays) VALUES (1, 0, 0);
