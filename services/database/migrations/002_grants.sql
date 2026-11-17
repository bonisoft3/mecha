-- Grant permissions to anon role
-- Migration: 002_grants  
-- Purpose: Set up table and sequence permissions for PostgREST API access

-- Grant permissions to anon role for all tables in public schema
GRANT USAGE ON SCHEMA public TO anon;

-- Grant select, insert, update, delete on all current and future tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon;

-- Grant usage on sequences (for auto-generated IDs)
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO anon;

-- The pipelines and the ticker write as `service` through crud, into any
-- table, as a caller's grants let them.
GRANT USAGE ON SCHEMA public TO service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service;

-- Electric snapshots a shape's rows before it streams them.
GRANT USAGE ON SCHEMA public TO electric;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO electric;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO electric;
