// pljs, QuickJS's PL/JavaScript, built as the `plv8` language every tier's
// database Jessie names: the container image (bayt.cue) and pronto's host
// Postgres (plugins/pronto/clusters/mecha.cue) both build it from here.
package pljs

import (
	"strings"
	ivm "github.com/bonisoft3/mecha/packages/incremental-views:incremental_views"
)

#Version: "1.0.5"
#Source: {
	repo:   "https://github.com/plv8/pljs.git"
	tag:    "v\(#Version)"
	commit: "194c4d5bc8f7e3130f9b310607bc3c51b232cbdc"
}
#Patches: ["patches/01-shared-lib-build", "patches/02-unicode-conflict"]

// The line of src/functions.c after which the `plv8` global and a no-op
// `print` are defined, so code written against plv8's globals runs.
#Needle: #"JS_SetPropertyStr(ctx, global_obj, "pljs", pljs);"#
#AliasLines: [
	#"  JS_SetPropertyStr(ctx, global_obj, "plv8", JS_DupValue(ctx, pljs));"#,
	#"  JS_SetPropertyStr(ctx, global_obj, "print", JS_Eval(ctx, "(function(){})", 14, "<init>", JS_EVAL_TYPE_GLOBAL));"#,
]

// The extension as `plv8`: its control lines, and its script with the
// language renamed.
#Control: [
	"comment = 'PL/JavaScript (v8 alias backed by QuickJS pljs)'",
	"default_version = '\(#Version)'",
	"module_pathname = '$libdir/pljs'",
	"relocatable = false",
	"schema = pg_catalog",
	"superuser = true",
	"trusted = true",
]
#Language: {from: "LANGUAGE pljs", to: "LANGUAGE plv8"}

// pljs raises every JavaScript error as "execution error" with the error in
// its detail; plv8 raises the error itself, which is what callers read (a
// PostgREST message, a reducer's refusal). Each site raises the error's first
// line instead, its whole text kept as the detail.
#Errors: {
	needle: #"#include "utils/rel.h""#
	lines: [
		"static char *pljs_err;",
		#"static char *pljs_line(const char *s) { return s ? pnstrdup(s, strcspn(s, "\n")) : "execution error"; }"#,
	]
	pattern:     #"errmsg\("execution error"\),\s*errdetail\("%s",\s*(.+?)\)\)\);"#
	replacement: #"errmsg("%s", pljs_line(pljs_err = $1)), errdetail("%s", pljs_err ? pljs_err : "")));"#
	// What each rewritten site, and nothing else, contains.
	marker: "pljs_err ? pljs_err"
	sites:  6
}

// A value as one single-quoted sh word.
#Sh: {
	v:   string
	out: "'" + strings.Replace(v, "'", "'\\''", -1) + "'"
}

// What #AliasLines leaves in functions.c exactly once: every tier that
// builds pljs checks it, so a tag whose source moved the needle fails there.
#AliasMarker: #""plv8", JS_DupValue"#

// The database's extensions, pljs as `plv8` and pg_ivm, built against one
// PostgreSQL's pg_config: the steps every tier that builds them runs, with
// `fetch` the downloader its image carries.
#Build: {
	pgConfig: string
	fetch:    *"wget -qO" | string
	steps: [
		"git clone --depth 1 --branch \(#Source.tag) --recurse-submodules \(#Source.repo) /tmp/pljs",
		#"test "$(git -C /tmp/pljs rev-parse HEAD)" = \#(#Source.commit)"#,
		"printf '%s\\n' \(strings.Join([for l in #AliasLines {(#Sh & {v: l}).out}], " ")) > /tmp/pljs-alias.c",
		"sed -i \((#Sh & {v: "/\(#Needle)/r /tmp/pljs-alias.c"}).out) /tmp/pljs/src/functions.c",
		"test \"$(grep -c -F \((#Sh & {v: #AliasMarker}).out) /tmp/pljs/src/functions.c)\" = 1",
		"printf '%s\\n' \(strings.Join([for l in #Errors.lines {(#Sh & {v: l}).out}], " ")) > /tmp/pljs-errors.c",
		"sed -i \((#Sh & {v: "\\|\(#Errors.needle)|r /tmp/pljs-errors.c"}).out) /tmp/pljs/src/pljs.c",
		"perl -0pi -e \((#Sh & {v: "s/\(#Errors.pattern)/\(#Errors.replacement)/g"}).out) /tmp/pljs/src/pljs.c",
		"test \"$(grep -c -F \((#Sh & {v: #Errors.marker}).out) /tmp/pljs/src/pljs.c)\" = \(#Errors.sites)",
		for f in #Patches {"patch -d /tmp/pljs -p1 -i \(f)"},
		"make -C /tmp/pljs/deps/quickjs -j\"$(nproc)\" libquickjs.a",
		"make -C /tmp/pljs -j\"$(nproc)\" PG_CONFIG=\(pgConfig) with_llvm=no install",
		"ext=\"$(\(pgConfig) --sharedir)/extension\"",
		"printf '%s\\n' \(strings.Join([for l in #Control {(#Sh & {v: l}).out}], " ")) > \"$ext/plv8.control\"",
		"sed \((#Sh & {v: "s/\(#Language.from)/\(#Language.to)/g"}).out) \"$ext/pljs--\(#Version).sql\" > \"$ext/plv8--\(#Version).sql\"",
		"rm -rf /tmp/pljs /tmp/pljs-alias.c /tmp/pljs-errors.c",
		"\(fetch) /tmp/pg_ivm.tar.gz '\(ivm.#Source.url)'",
		"echo '\(ivm.#Source.sha256)  /tmp/pg_ivm.tar.gz' | sha256sum -c -",
		"mkdir /tmp/pg_ivm && tar -xzf /tmp/pg_ivm.tar.gz --strip-components=1 -C /tmp/pg_ivm",
		"make -C /tmp/pg_ivm PG_CONFIG=\(pgConfig) && make -C /tmp/pg_ivm PG_CONFIG=\(pgConfig) install",
		"rm -rf /tmp/pg_ivm /tmp/pg_ivm.tar.gz",
	]
}
