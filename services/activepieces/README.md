# Activepieces runner

This service exposes admitted Activepieces actions through `POST /actions/<alias>`, with or without the trailing slash daprd drops.
The request is a closed JSON object containing `props` and requires a nonempty
`Idempotency-Key` header. Fixed properties and the configured identity property
cannot be supplied by the caller. The response contains `result`, or a safe error
with a failure kind and invocation ID.

`ACTIVEPIECES_MANIFEST` defaults to `/app/manifest.json`; `ACTIVEPIECES_REGISTRY`
defaults to `/app/registry.ts`; `PORT` defaults to 8080. The manifest declares
version 1, an optional content `revision`, limits (`timeoutMs`, `maxConcurrent`, `maxRequestBytes`,
`maxResultBytes`) and actions. Each action names a registry piece and action,
input and output JSON schemas, `fixedProps`, and optionally `idempotencyKeyProp`
and `auth` (`jsonSecret` and its JSON schema). The secret environment variable
contains the complete JSON auth value. All declared secrets are validated before
readiness; only the selected action's secret is sent to its child.
Schemas may reference only local fragments. The registry exports `pieces`, a map
of aliases to standard Activepieces piece objects. Registry imports and action
existence are checked in a subprocess before the server starts.

Each invocation starts a Deno subprocess with a cleared environment, no subprocess
or native FFI permission, cached dependencies only, and reads scoped to `/app`,
the runner, the registry directory and an explicitly configured `DENO_DIR`. The
child receives only its inputs and auth over stdin. It sends the result over a
bounded loopback connection; stdout and stderr are discarded. Network access is
available to the action. The deployment must preload the dependency cache and place
all package assets under those read paths. Code running in a piece is trusted and
can transmit its inputs and credentials over its network access.

This service hosts actions only. The
[[../../../../plugins/pronto/docs/decisions/2026-10-28-integrations|integration design]]
assigns trigger lifecycle and durable ingress to a planned shared host; those
capabilities are not implemented by this subprocess runner.
