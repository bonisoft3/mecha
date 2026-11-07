-- QuickJS's unicode under the plv8 alias, asserted where the image starts.
-- pljs.so once exported QuickJS's unicode_normalize; the postgres executable
-- defines its own, with other arguments, so String.prototype.normalize bound to
-- the backend's and failed ("[unsupported type]") or killed the backend with
-- signal 11. Each form, a compatibility character, case mapping and a unicode
-- regexp are checked so a clash on any libunicode path fails initdb here.
CREATE FUNCTION pg_temp.pljs_unicode_probe(s text) RETURNS text
LANGUAGE plv8 IMMUTABLE AS $probe$
const points = (t) => Array.from(t).map((c) => c.codePointAt(0).toString(16)).join(' ');
return [
  ...['NFC', 'NFD', 'NFKC', 'NFKD'].map((f) => f + ':' + points(s.normalize(f))),
  s.toUpperCase(),
  String(/\p{Ll}/u.test(s)),
].join('|');
$probe$;

DO $$ BEGIN
  IF pg_temp.pljs_unicode_probe('éﬁ') IS DISTINCT FROM 'NFC:e9 fb01|NFD:65 301 fb01|NFKC:e9 66 69|NFKD:65 301 66 69|ÉFI|true' THEN
    RAISE EXCEPTION 'pljs unicode is not QuickJS''s own: %', pg_temp.pljs_unicode_probe('éﬁ');
  END IF;
END $$;

