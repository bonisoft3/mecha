---
type: reference
title: PGlite for workerd
description: "@electric-sql/pglite 0.5.8 built so a Durable Object loads it as built, its data directory kept page by page in the object's SQLite, and the resumable, verified load that puts a directory there."
---

# PGlite for workerd

The database of mecha's [edge tier](../../docs/deployment.md#the-tiers): one
Durable Object runs PGlite over a data directory kept in the object's own
SQLite.

## The build

Stock PGlite does not load in workerd. It misdetects its environment, asks for
128 MiB at instantiation, compiles WebAssembly at runtime for plpgsql and its
callbacks (workerd: "Wasm code generation disallowed by embedder"), and re-arms
an idle timer every 10 s that keeps an object awake. This build has none of
those: plpgsql and dict_snowball linked in, host callbacks as imports,
`-sENVIRONMENT=web`, assets resolved against `import.meta.url` only when not
passed, a 16 MiB memory minimum, and no timer left pending between queries.
[`bayt.cue`](bayt.cue) pins every input; [`patches/`](patches) carries the
source changes, [`wasm.nu`](wasm.nu) the relink.

| Target | Image | Product |
|---|---|---|
| `wasm` | pglite-builder 3.1.74-7 | `release/`: `pglite.{js,wasm,data}`, `initdb.{js,wasm}` |
| `dist` | node 22.23.3, pnpm 9.7.0 | `dist/`: pglite's package over `wasm`'s release |
| `icu` | node 22.23.3 | `icu-root.tgz`: the five ICU 76 files a collation over the root locale (`und-u-…`) opens, out of 4,136 |
| `package` | scratch | both at the image root, for a local export |

`just build` (sayt's build verb, [`.say.yaml`](.say.yaml)) bakes `package` and
exports it to `dist/`, which a Worker imports and its wrangler config aliases
`@electric-sql/pglite` and `@electric-sql/pglite/basefs` to
([`test/wrangler.jsonc`](test/wrangler.jsonc)). `package` exists because a
target's `:outs` view keeps the `/monorepo/<dir>/` prefix, which a local export
would write under the destination; its image also carries bayt's `.bayt/`
scaffolding, so `dist/` holds a `.bayt/` that nothing reads.

The ICU archive is the root locale's because an isolate holds its data
modules in its 128 MB, and the full set is 12.8 MB. A collation over another
locale opens that locale's `coll/*.res` too, and fails without it.

`wasm.nu` builds at a fixed path, `/work/postgres-pglite`. Two clean builds
(`--no-cache`) gave byte-identical trees, `pglite.wasm` and `initdb.wasm`
included.

[`modules/`](modules) holds this package's own PostgreSQL modules, placed
beside contrib's and linked into the backend by `wasm.nu`'s module table, never
loaded at runtime (workerd compiles no WebAssembly then). `pgl_step` is a
machine's step as a host import: `pgl_step(name text, input jsonb)` hands the
host the machine's name and the step's input as JSON text and returns what it
answers, or raises the message the host answers after `!`, since a throw across
the import would unwind PostgreSQL's frames without their cleanup. The host
sets the step as `Module.pglStep` or `globalThis.__pgliteStep`
([mecha-edge](../mecha-edge/README.md#machines) does); a function over it is
`CREATE FUNCTION … LANGUAGE c AS '$libdir/pgl_step', 'pgl_step'`, resolved
through the static module table. 1,000 SQL→host→SQL round trips take 13 ms
([`test/host-step_test.ts`](test/host-step_test.ts)).

## The data directory

[`SqliteFS`](src/sqlite-fs.ts) is PGlite's filesystem over the
object's SQLite: a node per path, and a file's bytes as blocks keyed by
(file, index). PGlite's filesystem calls and `ctx.storage.sql` are both
synchronous, so Postgres reads a page from storage when it asks for it, as
OpfsAhpFS reads from an OPFS access handle; the isolate holds only the node
table, and the database is bounded by the object's storage, not its memory.
The default format uses raw 8 KiB blocks, matching Postgres pages.

`new DataDirectory(storage, { version: 1, blockSize: 131072, codec: 'deflate' })`
selects lossless zlib level-1 compression for a new directory. Blocks that would
grow are stored raw, with an encoding byte. Block sizes are powers of two from
8 to 128 KiB. `fs_format` persists the choice; reopening without options uses
that format, and conflicting options fail. Existing directories without format
metadata retain raw 8 KiB storage. Changing format requires a fresh import.
Inflation is bounded by the declared block size and damaged streams fail.

Decoded compressed blocks use a 4 MiB LRU budget, including their encoded copies.
Every lookup still reads authoritative SQLite bytes and compares them before
reusing decoded data. Writes, rollback and ID reuse therefore cannot expose a
stale decoded block; this cache saves inflation, not SQLite row reads.

Larger blocks reduce SQLite allocation overhead but amplify isolated page reads
and writes: updating one 8 KiB page can decompress and recompress 128 KiB.
Compression preserves PostgreSQL indexes, transactions and query semantics;
it does not require moving tables to another database engine.

[`DataDirectory`](src/data-directory.ts) owns it in an object. `initdb`
cannot run there, so a directory built on disk — by npm's PGlite, the same
Postgres 18 — arrives through `importing()` before `open()` starts PGlite
over it, with Postgres's memory cut to fit the isolate (`SETTINGS`). It opens
only a directory marked complete, which a load marks once every chunk is
verified: over a partial or absent one PGlite would run initdb and answer from
an empty database. Once open, an import is refused, since PGlite's writes make
the stored directory differ from its source; once complete, only a reset
starts another.

[`load.ts`](load.ts) is the sending side, given a function that delivers one
request to the object. It resumes where a run stopped: chunks only append and
each lands in one transaction, so a file's stored size says where to resume,
and a re-run sends only what is missing. A request the object never answered,
or answered with a 5xx, as when a deploy or an eviction restarts it, resumes
the run itself from what the object holds, a few times with a growing pause. A node the object holds that the
directory lacks, or holds longer, is another load's, and the run stops unless
`reset` starts over. It ends by hashing every stored chunk in the object
against the local bytes, then marks the directory complete. A complete
directory is live data, and a load without `reset` leaves it alone.

[`restore.ts`](restore.ts) builds such a directory from a plain `pg_dump`,
for a database too big to rebuild from its migrations (an archive): the roles
its grants and policies name first, since a dump carries none, then the dump,
its `COPY` blocks fed to PGlite a batch of rows at a time. It closes the
directory trimmed (`closeTrimmed`): the WAL segments a checkpoint pre-allocates
past the insert position, a GiB after a restore, are dropped rather than
shipped. A dump that
carries the `pgroll` schema carries the database's ledger, and
[`migrate.ts`](migrate.ts) applies the cluster's pgroll migrations it lacks,
as the cluster's migrate step (`services/migrate/migrate.sh`) would: in name
order, refusing one that sorts before the latest applied, each recorded as
`pgroll start --complete` records it. pgroll does not run in PGlite, so only
migrations of raw SQL apply, their `up` past the tier fence.
[`scripts.ts`](scripts.ts) is the other ledger, the docker appliance's
`_pronto_migrations` with a digest per script: what a directory being built
applied, by name, and what a release later hands a directory the object
kept — its files and its pgroll set as raw SQL — applied in name order past
the tier fence, seeds never; a recorded script with other text, or a
directory without the ledger, is refused by name.

## Measured

A spike deployed this build to Cloudflare with GolAberto's full archive
(5.2 GB, 1,346 files; 5.4 GiB in the object's SQLite) and saw no memory or CPU
kill; a cold start took 0.5–0.9 s. Under `wrangler dev`: boot about 220 ms,
page reads 1–2 ms warm and up to 175 ms cold, accent-insensitive search in
7–14 ms, a wake replaying unflushed WAL in 844 ms against 140 ms after a
checkpoint. Workers Paid holds such an archive; Free's 5 GB per account and
100,000 row writes a day do not.

The opt-in compression probe loaded a newer 7,341,424,680-byte archive into
1,951,252,480 bytes of actual Cloudflare SQLite storage: 73.4% smaller, with
56,995 block rows. All 2,937 source chunks verified before PostgreSQL opened.
Players, Flamengo rating history and table counts matched the original archive
on initial, warm and post-abort reads. [[spikes/compression-results.json]] records
the original measurements. That build's warm players query used 3,212 ms CPU and
3,941 ms object wall time; warm Flamengo rating history used 5 ms each.

The matched follow-up in [[spikes/query-memory-results.json]] found that 1 MiB
`work_mem` spilled 900 temporary pages. The current 8 MiB setting removed those
spills for this query. Two warm round trips took 481–570 ms with raw storage and
650 ms with compressed storage and the decoded-block cache. Results matched the
source archive. These are small latency samples, not capacity guarantees, and
`work_mem` applies per query operation, not as a total PostgreSQL memory cap.
The probes run on Paid; fitting Free's account storage budget does not prove
Free runtime quotas or its per-object size limit.

## Test

`just test` runs codec corruption checks and [`test/validate_test.ts`](test/validate_test.ts) against
[`test/worker.ts`](test/worker.ts) under `wrangler dev` at the `mise.toml` pin
([`wrangler-dev.ts`](wrangler-dev.ts), which mecha-edge's test runs too), for both
raw 8 KiB and compressed 128 KiB storage: two
directories seeded on disk and loaded, a second load that leaves the complete
one alone, an object with none that refuses to open, then in the object the checks the build exists for — no runtime
compilation, a PL/pgSQL trigger and DO block, the snowball dictionaries, the
root collation, a schema applied in the object, and no pending timer after a
boot, an eviction or `ctx.abort()`. Filesystem checks cover partial and sparse
writes, truncation, reopening and legacy formats; committed data and rolled-back
updates are checked after a process restart without an explicit checkpoint.
[`test/restore_test.ts`](test/restore_test.ts)
restores a dump Postgres 18 (in Docker) took of a table with a policy, an ICU
collation and a trigger; [`test/migrate_test.ts`](test/migrate_test.ts) gives
a directory restored from a database pgroll migrated (mecha's pinned image)
the set with one migration more.

## Compression probe

[[spikes/compression-wrangler.jsonc]] deploys an isolated, authenticated archive
copy using compressed 128 KiB blocks. Set its `PROBE_TOKEN` secret before use.
[[spikes/compression-load.ts]] takes the probe origin, a closed data directory,
and a private token file. It compresses upload chunks in transit and uses the
normal resumable import and complete-directory hash verification.

[[spikes/compression-check.ts]] has two modes: `reference <pgdata-copy> <json>`
records public player and rating queries from a disposable local archive copy;
`remote <origin> <json> <token-file>` compares them with the deployed database
cold, warm, and after an object abort. The probe exposes storage allocation;
the checker measures client round trips. CPU and object wall time come from
`wrangler tail --format json`: the in-Worker clock does not advance during
synchronous database work. SQL requests run in read-only transactions. Use a separate
namespace because the import operates on a complete PostgreSQL directory.
