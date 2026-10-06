# Electric image

The cluster uses the same pinned Electric 1.8.1 release on AMD64 and ARM64. Its image build runs `patch.exs` with the release's own Elixir compiler.

Electric accepts snapshot callers before asynchronous shape initialization finishes. `State.initialize` replaces the initial snapshot state and loses those callers. The snapshot can finish successfully while their HTTP requests wait until the 45-second timeout. The patch carries the waiting callers into the initialized state.

The build downloads one upstream source module from an immutable commit, verifies its SHA-256, changes one expression, compiles it and tests the actual consumer callbacks before writing the resulting module. Fetching the pinned source keeps its implementation upstream; the checksum and exact replacement prevent an upstream change from silently applying a different patch. No application starts and no database is needed during the build, but Electric's configuration reader requires placeholder `DATABASE_URL` and `ELECTRIC_SECRET` values.

The embedded regression covers early and late callers, fresh and restored snapshots, readiness replies and duplicate notifications. Run it against an unpatched image with `MECHA_ELECTRIC_TEST_ONLY=1` to demonstrate the failure. A future version bump must first pass that mode unmodified; then remove the patch and its image-build wiring together.

Upstream source: [Electric State at 0f404200](https://github.com/electric-sql/electric/blob/0f404200402f918a4b1596bc5c8a53479a435349/packages/sync-service/lib/electric/shapes/consumer/state.ex), under the upstream [Apache 2.0 license](https://github.com/electric-sql/electric/blob/0f404200402f918a4b1596bc5c8a53479a435349/LICENSE).
