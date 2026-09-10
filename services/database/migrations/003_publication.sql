-- Create publication for Conduit WAL consumer
-- Migration: 003_publication
-- Purpose: Enable at-least-once CDC delivery via Conduit

-- Create a publication for all tables so Conduit can consume WAL changes.
-- Conduit reads this publication via logical replication and delivers changes
-- to the configured HTTP destination with at-least-once guarantees.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'conduit_pub'
  ) THEN
    CREATE PUBLICATION conduit_pub FOR ALL TABLES;
  END IF;
END
$$;
