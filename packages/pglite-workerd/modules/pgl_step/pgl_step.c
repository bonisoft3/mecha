/*
 * pgl_step(name text, input jsonb) RETURNS jsonb: a machine's step, run by
 * the host that runs PGlite. PostgreSQL runs the same step in plv8; here the
 * JavaScript engine is the host, so the step is an import the object sets
 * as Module.pglStep (or globalThis.__pgliteStep), given the machine's name
 * and the step's input as JSON text. The host answers JSON text, or a
 * message after '!' for a step that failed: an answer, never a throw, since
 * a throw would unwind PostgreSQL's frames without their cleanup. The
 * message is raised here as the error the step's transaction aborts on, as
 * plv8 raises a rule's throw.
 */
#include "postgres.h"
#include "fmgr.h"
#include "utils/builtins.h"
#include "utils/jsonb.h"
#include <emscripten.h>

PG_MODULE_MAGIC;

EM_JS(char *, pgl_host_step, (const char *name, const char *json), {
  const step = Module['pglStep'] || globalThis.__pgliteStep;
  if (!step) return stringToNewUTF8('!pgl_step: the host set no step');
  return stringToNewUTF8(String(step(UTF8ToString(name), UTF8ToString(json))));
});

PG_FUNCTION_INFO_V1(pgl_step);
Datum
pgl_step(PG_FUNCTION_ARGS)
{
	text	   *name = PG_GETARG_TEXT_PP(0);
	Jsonb	   *input = PG_GETARG_JSONB_P(1);
	char	   *json = JsonbToCString(NULL, &input->root, VARSIZE(input));
	char	   *out = pgl_host_step(text_to_cstring(name), json);
	Datum		result;

	if (out[0] == '!')
	{
		char	   *message = pstrdup(out + 1);

		free(out);
		ereport(ERROR,
				(errcode(ERRCODE_EXTERNAL_ROUTINE_EXCEPTION),
				 errmsg("%s", message)));
	}
	result = DirectFunctionCall1(jsonb_in, CStringGetDatum(out));
	free(out);
	PG_RETURN_DATUM(result);
}
