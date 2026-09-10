# @mecha/lake

Browser-side consumer of a published DuckLake: engine boot, HTTP attach, and
offline preload. Publishing is the app's job — `guis/snapcards` does it from
its compose stack (`scripts/lake-publish.sql`, wired as a `release` flavor).

## Contract

- **Version pairing is load-bearing** — see `DUCKDB_WASM_VERSION` in
  `src/index.ts` for what breaks and what must be bumped together.
- A published lake is `catalog.ducklake` + `data/**.parquet` +
  `manifest.json` (the catalog's own file list; small tables ride catalog
  inlining and contribute no files). The static server must answer Range
  requests for HTTP attach; `preloadPublishedLake` needs only plain GETs.
- `attachPublishedLake` passes `OVERRIDE_DATA_PATH`: a lake records its
  `data_path` at creation, so attaching from an HTTP vantage must override it.
- Extensions (ducklake, parquet) load lazily at ATTACH from
  extensions.duckdb.org; offline consumers must attach while that host is
  reachable or cached.

## Offline serving

Apps on the browser platform should NOT ship a second service worker for lake
caching: MSW owns the scope (one worker per scope; a second registration
steals control). Serve or cache lake files through `bootPlatform`'s `routes`
extension instead.

`preloadPublishedLake` is the no-service-worker path — it pulls the lake into
duckdb-wasm's virtual filesystem and attaches from there.

## Provenance

This package generalises the browser tier proven by a spike deleted in
`a0c9f51e9`; `git show a0c9f51e9^:libraries/mecha/spikes/ducklake/README.md`
carries the full log. Worth reading before changing the CDC or publish side:
the pg_duckpipe blackbox findings (workers do not auto-resume after a Postgres
restart — the reason `snapcards/services/database/lake-supervisor.sh` exists),
the CDC battery (out-of-order commits, restart-mid-flush convergence,
exactly-once), and `browser/sw.js`, the only worked example of serving lake
files from Cache Storage with Range slicing.

One correction to that log: it concludes a blob worker must be built from
fetched source because it inherits the page's service-worker controller while
`importScripts` does not. True, but incomplete — a blob worker's base URL has
an opaque path, so any asset URL handed into it must be absolute. The spike
never hit this because its engine assets came from a CDN.
