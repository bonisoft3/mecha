# Build Feldera pipelines before deployment

Status: partially built; spike verified, release integration under verification.
The implementation contract is in [[../compute]].

## Decision

Compile Feldera SQL into application-specific native executables during the
release build. Deploy these executables and their shared libraries beside the
compute coordinator. The deployment runs the real Feldera engine; it does not
need Java, Cargo, or the pipeline manager to maintain its streaming relations.

This preserves the native semantics in [[../compute]] while moving compilation
off the small VM. It does not establish that Golaberto's five pipelines plus
PostgreSQL, Electric and request serving fit in 4 GiB. That requires an archive
bootstrap and steady-state workload measurement.

## Artifact and runtime boundary

An artifact binds the SQL, schemas, Feldera version, target architecture and
executable checksum. Build Linux amd64 for GCP e2; an executable built for the
developer's arm64 Docker host is not that release artifact. Use the pinned
0.367.0 image's optimized profile, which includes its prebuilt dependency cache.

The executable receives connector configuration at startup. Database credentials,
publication names and source schema names belong in this configuration, not in
the artifact identity. The artifact path separates these from SQL; the remote
manager path retains its existing SQL connector declarations.

The coordinator verifies artifacts and binds each expected incarnation to the
runtime UUID. A static Linux helper sets parent-death signaling before executing
the pipeline, checking the expected parent PID to reject startup after its parent
has already exited. This avoids a shell watchdog's race between reaping and
signaling a reused PID. Direct runtime query, ingress, completion and statistics
APIs remain available. Direct pause/resume use different routes from the manager
API; this is not simply changing `FELDERA_URL`.

Each pipeline needs an explicit memory budget within the appliance's total
budget. Feldera's memory-pressure setting is not a substitute for a process or
container resource limit. Persistent scratch storage is distinct from a durable
checkpoint: OSS checkpoint recovery remains unavailable in this pinned version.
Keep fresh CDC identities and baseline reconstruction on a fresh circuit.

## Alternatives

The stock OSS manager bundles the API, compiler and runner, with no public
artifact-import API or switch to disable its compiler service. Keeping that
manager is simpler for interactive SQL changes but does not deliver a small
runtime-only appliance. Seeding its internal database to import executables
would couple deployment to an undocumented storage protocol.

A custom remote-compiler service would retain manager APIs but add a service and
shared control-plane state. Running the compiled executable is a smaller
deployment boundary for release-time queries. Queries changed at runtime would
require a new build and release under this proposal.

Gen2 selectors exist in 0.367.0, but its pinned OSS image does not ship the
required `gen2-engine` executable. It is not a demonstrated alternative here.

## Evidence

The supplied empty executable ran independently with a 512 MiB container limit
and one CPU, reporting `Running`, version `0.367.0`, and about 65 MiB RSS. This
proves executable startup only; it is not an application sizing result.

The [[../../spikes/feldera-standalone/README|reproducible spike]] builds a
`FROM scratch` runtime image from the executable, its dynamically linked
libraries and CA certificates. Its only process is the pipeline. HTTP ingress
insert, update and delete produced the expected grouped counts and sums with
the compiler container already removed. PostgreSQL CDC baseline, insert, update
and delete also passed for two different source schemas and publications using
that same executable, with no intervening compilation.

The clean Deno run passed all eleven assertions on Linux arm64. Compilation took
about 57 seconds with the pinned image's warm optimized dependency cache; sampled
runtime RSS was 93–109 MiB under a 512 MiB container limit. These are small-circuit
measurements, not Golaberto capacity estimates. Build limits protected other
local workloads and are not release requirements. Exact artifact sizes, hashes,
image pins and observations are recorded in the spike's
[[../../spikes/feldera-standalone/results.json|results]].

Pinned upstream implementation:

- [Runtime CLI and HTTP server](https://github.com/feldera/feldera/blob/v0.367.0/crates/adapters/src/server.rs)
- [Manager executable launch](https://github.com/feldera/feldera/blob/v0.367.0/crates/pipeline-manager/src/runner/local_runner.rs)
- [All-in-one manager](https://github.com/feldera/feldera/blob/v0.367.0/crates/pipeline-manager/src/all_in_one.rs)
