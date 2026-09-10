-- Create entity tables (generated from schemas/*.hcl via atlas migrate diff)
COMMENT ON SCHEMA "public" IS 'Standard PostgreSQL public schema';

CREATE TABLE IF NOT EXISTS "public"."Hello" (
  "id" uuid NOT NULL DEFAULT uuidv7(),
  "createdAt" timestamptz NOT NULL DEFAULT NOW(),
  "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
  "message" character varying(500) NOT NULL,
  "processed_at" timestamptz NULL,
  "source" character varying(100) NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "public"."GroupHello" (
  "id" uuid NOT NULL DEFAULT uuidv7(),
  "createdAt" timestamptz NOT NULL DEFAULT NOW(),
  "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
  "messages" character varying(2000) NOT NULL,
  "processed_at" timestamptz NULL,
  "source" character varying(100) NULL,
  PRIMARY KEY ("id")
);
