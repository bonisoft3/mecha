CREATE SCHEMA IF NOT EXISTS compute;
REVOKE ALL ON SCHEMA compute FROM PUBLIC;

CREATE TABLE IF NOT EXISTS compute.job_result (
  key text PRIMARY KEY CHECK (key ~ '^[0-9a-f]{64}$'),
  result text NOT NULL,
  bytes bigint NOT NULL CHECK (bytes = octet_length(result) + 128),
  accessed timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS job_result_accessed ON compute.job_result(accessed, key);
CREATE TABLE IF NOT EXISTS compute.job_cache_size (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  entries bigint NOT NULL CHECK (entries >= 0),
  bytes bigint NOT NULL CHECK (bytes >= 0)
);
INSERT INTO compute.job_cache_size(entries, bytes)
SELECT count(*), coalesce(sum(bytes), 0) FROM compute.job_result
ON CONFLICT(singleton) DO NOTHING;
REVOKE ALL ON compute.job_result, compute.job_cache_size FROM PUBLIC;
