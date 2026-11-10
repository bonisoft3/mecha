# Feldera standalone runtime spike

This spike compiles a nonempty grouped `COUNT`/`SUM` circuit using the pinned
Feldera 0.367.0 OSS image, removes the compiler container, and runs its executable
in a `scratch` image. The runtime contains the executable, shared libraries and
CA certificates. It contains no pipeline manager, Java, Rust compiler, Cargo or
shell.

The same executable passes HTTP insert/update/delete checks and PostgreSQL CDC
baseline/insert/update/delete checks against two different source schemas and
publications. Only the runtime configuration changes between sources. The SQL
declares the input relation without a connector; the runtime attaches
`postgres_cdc_input` to that relation. This establishes the boundary needed to
keep publication identities fresh without recompiling.

## Run

Use Deno 2.9.7 and Docker with the local Buildx builder named after the active
Docker context. From this directory:

```sh
deno run -A run.ts /tmp/feldera-standalone-result linux/arm64
```

The output directory must not exist. Omit the platform to use the Docker server's
native architecture. Use `linux/amd64` for an artifact intended for GCP e2; this
can require emulation when the builder is ARM. Both container dependencies are
pinned by digest in `run.ts`.

Compilation uses the image's optimized dependency cache, one Cargo job, two CPUs
and a 3 GiB container limit. These are limits for this local experiment, not
release build requirements. Compilation fails after twenty minutes. Each runtime
gets one CPU, a 512 MiB container limit, and `max_rss=384MiB`. The isolated
PostgreSQL source gets a 256 MiB limit.

The script saves the binary and its dependencies under `rootfs/`, program info,
runtime configurations, compiler response, container logs, query results,
statistics, runtime file inventory, image size and binary SHA-256. Its
`result.json` records success only after cleanup. Containers, network and tagged
runtime image created by the script are removed. Downloaded dependency images
and local Buildx cache remain available for subsequent runs. Existing workloads
are left running.

## Evidence

[[results.json]] contains the clean Deno run: all eleven assertions passed.
Compilation completed in 57.464 seconds. Compiler cgroup peak reached its 3 GiB
limit, including page cache. Standalone runtime RSS samples ranged from 92.6 to
109.4 MiB. The unstripped executable is 368,109,952 bytes; the runtime image is
506,716,846 bytes (483.2 MiB).

The expected aggregates are:

| Operation | Category a: count / sum | Category b: count / sum |
| --- | --- | --- |
| CDC baseline | 2 / 30 | absent |
| Insert | 2 / 30 | 1 / 5 |
| Update | 2 / 60 | 1 / 5 |
| Delete | 1 / 40 | 1 / 5 |

HTTP updates use deletion of the old row followed by insertion of the new row.
CDC updates execute PostgreSQL `UPDATE` directly. The two CDC runs use
`epoch_one.orders` / `publication_one` and `epoch_two.orders` /
`publication_two`, with no intervening compiler execution.

## Limits

The measured artifact is Linux ARM64. This does not validate Linux AMD64, an e2
VM, the complete application pipelines, large input histories, sustained load or
five concurrent pipelines sharing 4 GiB. Runtime RSS samples are observations
after each assertion, not peak process memory. Compiler cgroup peak includes
file cache and all compiler-container processes; it is not compiler-process RSS.

Storage is disabled and every runtime starts a fresh circuit. This preserves the
existing OSS reconstruction approach; it does not add checkpoint recovery. The
spike proves artifact portability across connector configurations, not a public
manager artifact-import API or a finished application deployment integration.

The build extracts version-specific internal artifact files, so this workflow
must be revalidated before changing Feldera versions. The executable remains
unstripped; size optimization is outside this experiment.

See [[../../docs/decisions/2026-11-09-feldera-runtime-artifacts]] for the deployment
decision and remaining integration work.
