-- THE GRAND MARKET (src/bazaar.js). The market itself is on NEAR; these only keep a record so a card opens quickly, and link a Telegram player to their account.
CREATE TABLE IF NOT EXISTS bazaar_players (
  uid        INTEGER PRIMARY KEY,
  account    TEXT    NOT NULL,                       -- the player's account on the market: the hex of their first device's public key
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bazaar_ticks (
  tick INTEGER PRIMARY KEY,
  at   INTEGER NOT NULL,
  data TEXT    NOT NULL                              -- the market at that tick, in short: prices, stocks, tills
);
CREATE TABLE IF NOT EXISTS bazaar_news (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  at   INTEGER NOT NULL,
  kind TEXT    NOT NULL,                             -- the chain's event: trade, broke, lend, event ...
  data TEXT    NOT NULL,
  tx   TEXT
);
CREATE TABLE IF NOT EXISTS bazaar_decisions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant  TEXT    NOT NULL,
  tick      INTEGER NOT NULL,
  at        INTEGER NOT NULL,
  model     TEXT,
  sealed    INTEGER NOT NULL,                        -- 1: the chain checked NEAR AI's signature on this answer
  say       TEXT,
  why       TEXT,
  request   TEXT,                                    -- exactly what the model was sent, and exactly what it answered, with the proof: anyone can check them (near/scripts/verify_decision.mjs)
  response  TEXT,
  sig_text  TEXT,
  signature TEXT,
  signer    TEXT,
  tx        TEXT,
  pulled    TEXT                                     -- what the leash cut
);
CREATE INDEX IF NOT EXISTS bazaar_decisions_m ON bazaar_decisions (merchant, id);
-- what a merchant remembers of a customer: the last few words between them
CREATE TABLE IF NOT EXISTS bazaar_talk (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  account   TEXT    NOT NULL,
  merchant  TEXT    NOT NULL,
  at        INTEGER NOT NULL,
  said      TEXT,
  answered  TEXT,
  off       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS bazaar_talk_who ON bazaar_talk (account, merchant, id);
CREATE TABLE IF NOT EXISTS bazaar_limits (
  k     TEXT    PRIMARY KEY,
  n     INTEGER NOT NULL,
  until INTEGER NOT NULL
);
