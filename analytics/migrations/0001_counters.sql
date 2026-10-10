-- Anonymous daily usage counters. No identifier, no timestamp finer than a day, no IP address.
CREATE TABLE daily_counts (
  day       TEXT    NOT NULL, -- YYYY-MM-DD (UTC, as sent by the app)
  event     TEXT    NOT NULL,
  format    TEXT    NOT NULL DEFAULT '', -- file format for open_file/export, otherwise ''
  version   TEXT    NOT NULL,
  os        TEXT    NOT NULL,
  installer TEXT    NOT NULL,
  count     INTEGER NOT NULL,
  PRIMARY KEY (day, event, format, version, os, installer)
);

CREATE INDEX daily_counts_day ON daily_counts (day);
