# DuckDB for workerd

[[../build.ts]] packages DuckDB-Wasm `1.33.1-dev57.0` (engine `v1.5.4`) for a
separate query Worker. [[../src/runtime.js]] supplies its blocking runtime.

The build checks SHA-256 for the upstream browser loader and signed JSON/ICU
extensions. [[../native/build.ts]] builds the exception-handling engine and its
matching JavaScript glue from the sources in [[../native/manifest.json]].
Version-specific loader patches check exact occurrence counts. Arrow `17.0.0` is bundled locally with the loader using the
package's lockfile. The output has no npm imports or account configuration.

```ts
import { packageDuckDB } from './build.ts'
const { fingerprint, assetsDirectory } = await packageDuckDB('/output/duckdb')
```

`fingerprint` hashes the names and complete bytes of every emitted runtime file,
WASM module and extension asset, including `native-build.json` with pinned
source/toolchain inputs and patch/build-script hashes. It changes with the
loader, runtime, Arrow, extensions, callbacks or native build provenance. Packaging subprocesses run from this package,
so the caller's working directory cannot change bundler dependency semantics.
`assetsDirectory` identifies the directory to
bind as `ASSETS`. The output can move as one directory.

The caller owns the Worker entrypoint and Wrangler configuration. Use
`assets.directory: './duckdb/assets'`, `assets.binding: 'ASSETS'`,
`assets.run_worker_first: true`, and a `CompiledWasm` rule for `**/*.wasm`.
The runtime entrypoint uses static imports relative to itself:

```js
import { createDuckDB } from './duckdb/runtime.js'
const db = await createDuckDB(env.ASSETS, { memoryLimit: '64MB' })
const connection = db.connect()
try {
  const statement = connection.prepare('SELECT ?::INTEGER AS answer')
  try { return statement.query(42).toArray().map((row) => row.toJSON()) }
  finally { statement.close() }
} finally { connection.close() }
```

Initialize inside an event or Durable Object initialization scope. The only asset
awaits happen during initialization. SQL queries, prepared statements and
connection close use DuckDB's synchronous blocking bindings; results are Arrow
tables. The facade excludes the upstream async streaming and raw WASM APIs.
It also exposes synchronous Arrow inserts, file registration/cleanup methods,
`getVersion()`, `getFeatureFlags()` and `memoryBytes`.

The adapter allocates C-call string arguments on the WASM heap and releases them
after each call. Upstream Emscripten copies those strings onto a fixed stack,
which can trap before executing a large prepared parameter. Heap allocation
removes that stack-size restriction; large JSON inserts still need bounded
batches to limit DuckDB's parsing and expression working set.

Each instance has its own browser runtime, including the file and UDF maps that
the upstream singleton's methods close over. Every exposed synchronous engine
call saves, selects and restores `globalThis.DUCKDB_RUNTIME`. Initializations
share a queue across this runtime module; another instance cannot initialize
until its predecessor finishes. A ready instance can execute during another
instance's initialization and restores that initialization's runtime afterward.
An asset or preflight failure rejects its caller and releases the queue for a
later attempt. A failure after engine instantiation begins poisons subsequent
initialization requests in that isolate; callers must surface the failure.

JSON and ICU load from original signed Worker Asset bytes while linking their
matching statically imported WASM modules. Runtime compilation and JavaScript
code generation fail deterministically. [[../thunks.json]] supplies 28 pinned
callback signatures; an unknown signature or extension fails. This bounded set
does not establish support for every upstream DuckDB or Arrow API.

The runtime selects UTC, one thread, a default `64MB` engine memory limit,
preserves insertion order, and disables extension autoloading,
installation and external access after loading
JSON/ICU. SQL cannot read local or remote files, including registered buffers;
materialize captured rows through inserts. The facade's file-copy operation is
also subject to that engine restriction. The engine memory limit is not total
isolate memory, and WASM linear memory does not shrink after a large query.

## Durable Object storage

Pass the object's synchronous SQLite binding and explicit file budgets to store
the DuckDB database, WAL and temporary files outside WASM memory:

```js
const db = await createDuckDB(env.ASSETS, {
  storage: ctx.storage.sql,
  path: '/database.duckdb',
  temporaryDirectory: '/tmp',
  maxDatabaseBytes: 256_000_000,
  maxTemporaryBytes: 512_000_000,
  memoryLimit: '32MB',
})
```

Storage mode defaults to `32MB` and disables insertion order preservation. The
in-memory defaults above remain unchanged. [[../src/sqlite-filesystem.js]]
implements DuckDB's synchronous filesystem callbacks with SQLite rows containing
64 KiB blocks. Reads copy directly into WASM memory, and writes read at most one
old block at a time. There is no JavaScript block cache or whole-file buffer.
The persisted format records its version, block size and paths; a mismatch fails.

The database budget covers the sum of logical file lengths outside the temporary
directory, including the WAL. The temporary budget covers files inside that
directory, and also configures DuckDB's own temporary storage limit. Growth is
checked before changing blocks. These are file budgets; SQLite row and database
overhead is additional. Storage errors and exhausted budgets propagate to the
caller. Directory enumeration is unsupported and fails when requested.

Only one open runtime may own a SQLite binding in this runtime module. Close all
connections and statements, then call `db.close()` to close the database and
release ownership. `db.reopen()` synchronously reacquires ownership, opens the
persisted database, and reapplies extensions and memory/settings limits. An old
connection cannot execute after closing. Closing preserves WASM allocation;
reopening reuses that allocation. A failed engine reopen retains ownership and
requires replacing the isolate. A fresh initialization discards abandoned
temporary files while preserving the database and WAL. SQLite writes are
synchronous; Durable Object storage supplies their transaction/output gate,
so the filesystem sync callback has no separate buffer to flush.

[[../test/crash-worker.js]] commits a row, returns its response, aborts the
Durable Object in a separate request without closing DuckDB, and verifies the
row after a new object instance reopens the database and replays its WAL.
The test checks that the instance changed and that a nonempty WAL existed
before the abort. It also exercises [[../../mecha-edge/src/paged-execution.ts]]:
commit revision one, abort, recover and commit an update/MERGE at revision two,
retry that commit, abort again, and verify final output and SQL scratch state.
`COMMIT` durability does not require an added checkpoint.

[[../native/filesystem.patch]] fixes three upstream native filesystem defects:
append handles start at EOF in both filesystem layers, reopened buffered handles
retain their new flags, and unlink evicts closed buffered pages before deleting
the physical file and its metadata. The native page cache is bounded to 256
16 KiB pages, or 4 MiB. Main database and spill IO bypass this cache.

The crash fixture also tests raw recovery followed by another commit and crash,
and repeated automatic checkpoints followed by a final commit and crash. The
unmodified engine overwrote recovered WAL data and retained stale WAL tails
after checkpoint rotation; acknowledging `COMMIT` alone was insufficient with
that engine. The native fixes apply before the SQLite adapter receives IO.

SQL still has external access disabled. Filesystem callbacks provide internal
database and spill IO; SQL cannot read arbitrary local or remote input files.
Query results remain Arrow tables; consumers must bound result size or
materialize results in DuckDB and read bounded pages.

[[../test/storage-worker.js]] exercises a 2.5 million row database in real local
workerd: 320,000,000 bytes of string payload, a 170,930,176-byte database file,
forced external sort, hash join and aggregation, and close/reopen. Every
operation returns the expected count and sum and performs temporary block
writes. Its observed WASM heap high water mark is 104,529,920 bytes at a `32MB`
engine memory limit. It also checks capture transfer, identical and conflicting
chunk retries, query materialization, and paged result reads across reopen using
[[../../mecha-edge/src/paged-query.ts]].

The same synthetic workload passed against a temporary hosted Worker under
the hosted 128 MB isolate limit. Total isolate memory was not separately
measured: JavaScript, extensions and runtime allocations add to WASM memory,
and the local fixture alone does not enforce that hosted limit. Wider 128-byte sort and grouping keys exhausted
the `32MB` DuckDB buffer budget in the exploratory fixture even with disk
available. Queries can fail their working memory limit, and WASM memory does not
shrink afterward. A disk-backed database alone does not establish that every
computation fits a hosted isolate.

## Native build

Cold builds require Docker on macOS, Linux and Windows. Every host uses the same
`linux/amd64` Emscripten image by digest, with the pinned Linux Deno, CMake and
Ninja artifacts in [[../native/manifest.json]]. Windows does not need a host C++
compiler or Python installation. The Linux build cache lives in the
`duckdb-workerd-native-v1` Docker volume, so it supports Unix symlinks independently
of the host filesystem. Verified WASM and matching glue are cached under Deno's
cache directory. Runtime execution needs none of these build tools.

The builder verifies source/tool downloads and both generated artifact hashes,
serializes concurrent builds, uses four compiler workers, and stops below
15 GiB free disk headroom on the host or build volume. Source paths are mapped
to `/duckdb-native`, build time uses the pinned source commit epoch, and
[[../native/arrow.patch]] removes absolute mapping arguments from Arrow's
recorded compiler metadata. The resulting WASM must contain no build-directory
prefix. [[../native/settings.patch]] fixes standalone source version reporting
and the Ninja build/install commands for Arrow.

## Verification

From this package:

Run these commands through Sayt's bootstrapped mise. For direct invocation,
set `SAYT_MISE_BIN` to that executable and use it in place of `mise` below;
the local Wrangler fixture requires this variable to resolve its pinned tools.

```sh
mise trust mise.toml
mise install
mise exec -- deno install --frozen
mise exec -- deno check build.ts test/prepare.ts test/integrate.ts
mise exec -- deno test -A test/*_test.ts
mise exec -- deno run -A test/integrate.ts
```

[[../test/runtime_test.ts]] suspends one initialization while a ready instance
executes successful and failing synchronous calls, and verifies that a third
initialization cannot start early. [[../test/integrate.ts]] builds the actual
runtime and starts only its isolated local Wrangler fixture. It checks two
concurrent initializations, interleaved tables and prepared statements, JSON,
large UTF-8 parameters, ICU timezone conversion, runtime restoration and
external-access rejection. It also checks that ordered query rows survive the
outer JSON projection used by the snapshot transport.
[[../test/sqlite-filesystem_test.ts]] checks sparse block writes, truncate/reopen,
file budgets, ownership exclusion and persisted format rejection.
The integration fixture also runs the Durable Object storage and paged-capture
checks described above. It performs no deployment.
