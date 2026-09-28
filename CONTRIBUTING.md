---
type: howto
title: Contributing to mecha
description: Changing mecha itself — the workflows, what derives from schema, and where each subsystem is argued.
---

# Contributing to mecha

For running the stack and changing what it generates. Two things make the
commands make sense: **the tables are derived from schema** — entities are
Protocol Buffers, and hand-editing a generated file is work the next `generate`
discards — and **capabilities are additive**
([invariant 7](README.md#7-additive-capabilities)).

## Workflows

Installing, generating, starting the stack, the smoke suites and cleanup are
the README's [Local Development](README.md#local-development). Beside them:

```bash
task buf:generate              # proto → JSON Schema
task cue:generate              # JSON Schema → Atlas HCL (CUE + gomplate)
task atlas:hash                # regenerate atlas.sum after a migration change

task launch                    # generate, then the whole stack with --watch
sayt launch                    # `compose up launch --wait`: the stack, detached once healthy
sayt launch@local              # native, no Docker (docs/deployment.md#the-tiers)

task test                      # cue vet + buf lint + the ticker's Deno tests; no Docker
task benchmark                 # startup, CRUD and CDC latency (scripts/benchmark.nu)
```

**Adding an entity**: define it in `proto/`, register it in `tmpl.cue` (embed
the generated schema and add it to `_entityBase`; `Entities` derives the
lowercase name and the id pattern), then `task generate` and
`task atlas:diff -- <name>`, list the new migration in `state.migrations` in
`bayt.cue`, and add the entity to each list that names it by hand
([schema](docs/schema.md#what-else-names-an-entity)); then `sayt launch`.

**A write that does not come back**: probe it hop by hop
([change capture](docs/change-capture.md#when-a-write-does-not-come-back)).

Each subsystem's document is listed in [docs/index.md](docs/index.md).
