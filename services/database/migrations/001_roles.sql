-- Create PostgREST roles
-- Migration: 001_roles
-- Purpose: Set up basic authentication roles for PostgREST API access

-- Create PostgREST roles if they don't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOINHERIT;
  END IF;
  
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOINHERIT;
    GRANT anon TO authenticator;
  END IF;
END
$$;