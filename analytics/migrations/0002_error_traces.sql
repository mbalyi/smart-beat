-- Anonymised error traces (#242). A trace is the command name and app-relative code locations of an
-- `error` event, already scrubbed by the app and checked again by the Worker: no message, no file
-- name, no path outside the app, no identifier. `daily_counts` is not touched.
CREATE TABLE trace_frames (
  hash      TEXT NOT NULL PRIMARY KEY, -- first 16 hex chars of SHA-256 of the top 2 frames joined by a newline
  frames    TEXT NOT NULL,             -- JSON array of up to 8 frames
  first_day TEXT NOT NULL              -- YYYY-MM-DD the hash was first seen
);

CREATE TABLE error_traces (
  day       TEXT    NOT NULL, -- YYYY-MM-DD (UTC, as sent by the app)
  hash      TEXT    NOT NULL,
  format    TEXT    NOT NULL, -- "<area>:<kind>" of the error event
  ext       TEXT    NOT NULL DEFAULT '', -- known file extension, "other", or '' when none
  version   TEXT    NOT NULL,
  os        TEXT    NOT NULL,
  installer TEXT    NOT NULL,
  count     INTEGER NOT NULL,
  PRIMARY KEY (day, hash, format, ext, version, os, installer)
);

CREATE INDEX error_traces_day ON error_traces (day);
