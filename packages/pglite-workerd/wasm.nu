# Builds PGlite's backend for workerd inside electricsql/pglite-builder, from
# the postgres-pglite tree at <src> patched with patches/postgres-pglite.patch,
# and writes pglite.{js,wasm,data} and initdb.{js,wasm} to <out>. Upstream's
# build-pglite.sh configures, builds and installs Postgres (its steps 1-2,
# unchanged); the backend is then linked again for workerd:
#   - no dynamic linking: plpgsql and dict_snowball are linked in, found by
#     pgl_dlopen() through a generated pgl_static_modules table, and the FS
#     bundle carries an empty placeholder .so for each (dfmgr stat()s the file
#     before dlopen) and no other module;
#   - -sENVIRONMENT=web: no node or worker branches in the glue;
#   - INITIAL_MEMORY=16MB, growing on demand.
# The tree is built at a fixed path, /work/postgres-pglite, whatever directory
# the sources unpack to, and removed with the install once the outputs are
# copied.
# Usage: nu wasm.nu <src> <out>

const TREE = '/work/postgres-pglite'
const STATIC = '/work/static'
const MODULES = [[name dir]; [plpgsql src/pl/plpgsql/src] [dict_snowball src/backend/snowball] [pgl_step contrib/pgl_step]]
# What the TypeScript side calls; nothing else is kept alive.
const EXPORTS = [
  _main _malloc _free _fopen _fclose _fflush _pclose ___errno_location _strerror
  _pgl_freopen _pgl_pq_flush _pgl_run_atexit_funcs _pgl_sendConnData _pgl_setPGliteActive
  _pgl_setPGliteExitStatus _pgl_getPGliteExitStatus _pgl_startPGlite _pgl_getMyProcPort
  _pq_buffer_remaining_data _ProcessStartupPacket _PostgresMainLoopOnce _PostgresMainLongJmp
  _PostgresSendReadyForQueryIfNecessary _IsTransactionBlock _emscripten_force_exit
]
const RUNTIME = [FS MEMFS PROXYFS setValue getValue UTF8ToString stringToNewUTF8 stringToUTF8OnStack callMain ENV]

def words []: string -> list<string> { split row --regex '\s+' | where $it != '' }

# A C line with {m} and {f} filled: C's parentheses never meet nushell's
# string interpolation.
def fill [m: string, f: string = '']: string -> string {
  str replace --all '{m}' $m | str replace --all '{f}' $f
}

# Upstream's configure + make + install, cut before its extension steps.
# Returns the compile flags and install prefix it computed.
export def upstream []: nothing -> record {
  let script = open build-pglite.sh | lines
  let steps = $script | take until {|l| $l starts-with '# Step 3.1' }
  if ($steps | length) == ($script | length) { error make {msg: "build-pglite.sh has no '# Step 3.1'; its steps moved"} }
  $steps | where $it != 'emcc --clear-cache'
    | append $'printf "%s\n" "$PGLITE_CFLAGS" > ($STATIC)/cflags'
    | append $'printf "%s\n" "$INSTALL_FOLDER" > ($STATIC)/prefix'
    | str join "\n" | save -f /work/steps.sh
  ^bash /work/steps.sh
  {cflags: (open ($STATIC | path join cflags) | words), prefix: (open ($STATIC | path join prefix) | str trim)}
}

# Each module's objects rebuilt with its entry points renamed, so several
# share the backend's namespace, with its SQL-callable functions.
export def modules []: nothing -> table {
  $MODULES | each {|m|
    ^emmake make -C $m.dir PORTNAME=emscripten clean
    ^emmake make -C $m.dir PORTNAME=emscripten -j ('COPT=-D_PG_init=pgl_{m}__PG_init -DPg_magic_func=pgl_{m}_Pg_magic_func' | fill $m.name)
    let objs = glob $'($TREE)/($m.dir)/**/*.o' | sort
    let syms = ^$env.LLVM_NM --defined-only -g ...$objs | lines
    let funcs = $syms | parse --regex '^\S+ \S pg_finfo_(?<f>\S+)$' | get f | sort | uniq
    if ($funcs | is-empty) { error make {msg: $'($m.name): no pg_finfo_ symbols'} }
    '' | save -f ($STATIC | path join lib postgresql $'($m.name).so')
    $m | insert objs $objs | insert funcs $funcs | insert init ($syms | any {|l| $l ends-with (' pgl_{m}__PG_init' | fill $m.name) })
  }
}

# The pgl_static_modules table pgl_dlopen() reads.
export def static-table [modules: table]: nothing -> string {
  let entries = $modules | each {|m|
    let init = if $m.init { ['extern void pgl_{m}__PG_init(void);'] } else { [] }
    let initSym = if $m.init { ['  {"_PG_init", (void *) pgl_{m}__PG_init},'] } else { [] }
    [
      ...($init | each { fill $m.name })
      ('extern const Pg_magic_struct *pgl_{m}_Pg_magic_func(void);' | fill $m.name)
      ...($m.funcs | each {|f| [
        ('extern PGDLLEXPORT Datum {f}(PG_FUNCTION_ARGS);' | fill $m.name $f)
        ('extern PGDLLEXPORT const Pg_finfo_record *pg_finfo_{f}(void);' | fill $m.name $f)
      ]} | flatten)
      ('static const pgl_static_symbol {m}_symbols[] = {' | fill $m.name)
      ('  {"Pg_magic_func", (void *) pgl_{m}_Pg_magic_func},' | fill $m.name)
      ...($initSym | each { fill $m.name })
      ...($m.funcs | each {|f| [
        ('  {"{f}", (void *) {f}},' | fill $m.name $f)
        ('  {"pg_finfo_{f}", (void *) pg_finfo_{f}},' | fill $m.name $f)
      ]} | flatten)
      '  {NULL, NULL}'
      '};'
    ]
  } | flatten
  [
    '/* The modules linked into this backend (pglite-build/wasm.nu). */'
    '#include "postgres.h"'
    '#include "fmgr.h"'
    ('#include "{m}/pglite/src/pglitec/pgl_static_modules.h"' | fill $TREE)
    ...$entries
    'const pgl_static_module pgl_static_modules[] = {'
    ...($modules | each {|m| '  {"{m}", {m}_symbols},' | fill $m.name })
    '  {NULL, NULL}'
    '};'
    ''
  ] | str join "\n"
}

# The backend linked for workerd, in src/backend.
export def link [modules: table, cflags: list<string>, prefix: string] {
  static-table $modules | save -f ($STATIC | path join pgl_static_modules.c)
  ^emcc ...$cflags $'-I($TREE)/src/include' -c -o ($STATIC | path join pgl_static_modules.o) ($STATIC | path join pgl_static_modules.c)
  # The backend's own link line, printed without upstream's LDFLAGS_EX: its
  # pglite target recurses into src/timezone and would relink zic with
  # these flags.
  "print-link:\n\t@echo '$(CFLAGS) $(call expand_subsys,$(OBJS)) $(LDFLAGS) $(LIBS)'\n" | save -f ($STATIC | path join print.mk)
  let backend = ^make -s -C src/backend -f Makefile -f ($STATIC | path join print.mk) print-link PORTNAME=emscripten LDFLAGS_EX= LDFLAGS_EX_BE= | words
  let ldflags = [
    -sWASM_BIGINT -sSUPPORT_LONGJMP=emscripten -sFORCE_FILESYSTEM=1 -sUSE_PTHREADS=0
    -sEXIT_RUNTIME=1 -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=Module -sALLOW_MEMORY_GROWTH
    -sERROR_ON_UNDEFINED_SYMBOLS=1 -sINVOKE_RUN=0
    $'($TREE)/pglite/src/pglitec/pglitec.o' ($STATIC | path join pgl_static_modules.o)
    ...($modules | sort-by name | get objs | flatten)
    -lproxyfs.js --post-js $'($TREE)/pglite/scripts/doNotSetExitCode.js'
  ]
  let preload = [
    [$'($TREE)/pglite/static/PGPASSFILE' /home/postgres/.pgpass]
    [$'($TREE)/pglite/static/empty' /pglite/bin/initdb]
    [$'($TREE)/pglite/static/empty' /pglite/bin/pg_dump]
    [$'($TREE)/pglite/static/empty' /pglite/bin/postgres]
    [$'($prefix)/share/postgresql' /pglite/share/postgresql]
    [$'($STATIC)/lib/postgresql' /pglite/lib/postgresql]
    [$'($TREE)/pglite/static/password' /pglite/password]
    [$'($TREE)/pglite/static/empty' /pglite/pgstdin]
    [$'($TREE)/pglite/static/empty' /pglite/pgstdout]
    [$'($TREE)/pglite/static/locale-a' /pglite/locale-a]
    [$'($TREE)/pglite/static/minimal-icu/76.1' /pglite/icu]
  ] | each {|p| [--preload-file $'($p.0)@($p.1)'] } | flatten
  cd src/backend
  (^emcc ...$backend ...$ldflags ...$cflags
    -sENVIRONMENT=web -sSTACK_SIZE=8MB -sINITIAL_MEMORY=16MB -sIMPORTED_MEMORY=1
    $'-sEXPORTED_RUNTIME_METHODS=($RUNTIME | str join ",")' $'-sEXPORTED_FUNCTIONS=($EXPORTS | str join ",")'
    ...$preload -o pglite.js)
}

def main [src: path, out: path] {
  let out = $out | path expand
  let patch = $env.FILE_PWD | path join patches postgres-pglite.patch
  rm -rf /work
  mkdir ($STATIC | path join lib postgresql)
  cp -r $src $TREE
  cd $TREE
  ^git apply $patch
  let built = upstream
  # The package's own modules, placed in the tree beside contrib's.
  cp -r ($env.FILE_PWD | path join modules pgl_step) ($TREE | path join contrib pgl_step)
  link (modules) $built.cflags $built.prefix
  mkdir $out
  cp src/backend/pglite.js src/backend/pglite.wasm src/backend/pglite.data ($built.prefix | path join bin initdb.js) ($built.prefix | path join bin initdb.wasm) $out
  cd /
  rm -rf /work $built.prefix
}
