-- The Postgres seat of a validation, in the shape pronto's emit.cue renders:
-- text-answering plv8 predicates handed their world by a PL/pgSQL trigger that
-- tells a refusal from a program error. Mounted by mecha's own compose only; an
-- app's tree emits its own 008_validations.sql.
CREATE EXTENSION plv8;

-- A SECURITY DEFINER read under FORCE ROW LEVEL SECURITY is still scoped by the
-- caller's app.scopes unless the definer itself bypasses RLS.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'validation triggers require a migration role that bypasses RLS (superuser or BYPASSRLS): %', current_user;
  END IF;
END $$;

-- Floored by the tenancy policy, and both rows in one scope no request holds:
-- the trigger below reads them anyway, because it is SECURITY DEFINER owned by
-- the initdb superuser. What anon sees of this table is the smoke's assertion.
CREATE TABLE "public"."Owned" (
  "id" text NOT NULL,
  "owner" text NOT NULL,
  "scope_id" text NOT NULL,
  PRIMARY KEY ("id")
);
INSERT INTO "public"."Owned" VALUES ('t1', 'alice', 'user:alice'), ('t2', 'bob', 'user:alice');
CALL rls_protect('"Owned"');

CREATE TABLE "public"."Guarded" (
  "id" uuid NOT NULL DEFAULT uuidv7(),
  "owner" text NOT NULL,
  "target" text NOT NULL,
  PRIMARY KEY ("id")
);
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."Owned", "public"."Guarded" TO anon;

CREATE FUNCTION guarded_validation_own_target(state jsonb, event jsonb) RETURNS text
LANGUAGE plv8 IMMUTABLE AS $validation$
const verdict = ((state, event) => state.rows.owned.every((o) => o.owner !== event.row.owner))(state, event);
return verdict === true ? "true" : verdict === false ? "false" : "answered " + typeof verdict;
$validation$;

REVOKE EXECUTE ON FUNCTION guarded_validation_own_target(jsonb, jsonb) FROM PUBLIC;

-- A predicate that answers neither true nor false, so the smoke pins the
-- wrapper's program-error arm.
CREATE FUNCTION guarded_validation_unanswered(state jsonb, event jsonb) RETURNS text
LANGUAGE plv8 IMMUTABLE AS $validation$
const verdict = ((state, event) => undefined)(state, event);
return verdict === true ? "true" : verdict === false ? "false" : "answered " + typeof verdict;
$validation$;

REVOKE EXECUTE ON FUNCTION guarded_validation_unanswered(jsonb, jsonb) FROM PUBLIC;

-- A bare throw, so the smoke pins that it is NOT a refusal.
CREATE FUNCTION guarded_validation_throws(state jsonb, event jsonb) RETURNS text
LANGUAGE plv8 IMMUTABLE AS $validation$
throw new Error("not a refusal");
$validation$;

REVOKE EXECUTE ON FUNCTION guarded_validation_throws(jsonb, jsonb) FROM PUBLIC;

-- The emitter inlines each predicate's world at its call; the fixture hoists it
-- so one world reaches whichever of the three the row's target routes to.
CREATE FUNCTION guarded_validate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  items jsonb;
  event jsonb;
  state jsonb;
  v text;
BEGIN
  items := CASE WHEN TG_OP = 'UPDATE' THEN jsonb_build_array(to_jsonb(OLD)) ELSE '[]'::jsonb END;
  event := jsonb_build_object('type', lower(TG_OP), 'row', to_jsonb(NEW));
  state := jsonb_build_object('items', items, 'rows', jsonb_build_object('owned', (SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM "Owned" r WHERE r."id" = NEW."target")));
  IF NEW."target" = 'boom' THEN
    PERFORM guarded_validation_throws(state, event);
  END IF;
  v := CASE WHEN NEW."target" = 'shrug' THEN guarded_validation_unanswered(state, event)
            ELSE guarded_validation_own_target(state, event) END;
  IF v = 'false' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'validation Guarded.own-target';
  ELSIF v IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'predicate Guarded.own-target ' || coalesce(v, 'answered nothing');
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER guarded_validate AFTER INSERT OR UPDATE ON "Guarded"
  FOR EACH ROW EXECUTE FUNCTION guarded_validate();
