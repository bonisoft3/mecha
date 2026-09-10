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