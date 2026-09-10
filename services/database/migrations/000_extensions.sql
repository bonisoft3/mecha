-- Create required PostgreSQL extensions
-- Migration: 000_extensions
-- Purpose: Set up database extensions needed by the application

-- Create pgcrypto extension for UUID generation and cryptographic functions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- TODO: Add other extensions as needed
-- CREATE EXTENSION IF NOT EXISTS pg_jsonschema;  -- For CEL validation from protobuf