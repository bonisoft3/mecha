-- Text compared without its accents, so "Reuniao" finds "Reunião".
-- unaccent() is STABLE: its dictionary is a catalog row a later ALTER could
-- change, so a generated column or an index cannot call it. The wrapper
-- promises what the rules file keeps true, names the dictionary, and is bound
-- when created, so no search_path a session sets reaches it.
CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA public;
CREATE OR REPLACE FUNCTION public.immutable_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  RETURN public.unaccent('public.unaccent'::regdictionary, $1);
