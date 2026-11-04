# Activepieces mail

The `mail` piece exposes the `send-mail` action. Its input, output and optional custom authentication are described by the adjacent JSON schemas. SMTP host, port, STARTTLS, message ID domain and optional CA certificates are action properties; credentials use the Activepieces custom authentication context. The request key determines a stable Message-ID but does not deduplicate deliveries. Each invocation makes one SMTP attempt.

Run `deno task --frozen-lockfile test` to test the action and `deno task --frozen-lockfile build` to produce the package export in `dist/index.js`. The build bundles the schemas and leaves the pinned npm dependencies external.


The app selects this package through its
[[../../../../plugins/pronto/docs/activepieces-hatches|Activepieces hatch]].
`src/index.ts` and the built export have no framework imports. Configuration and
credentials are ordinary action properties/auth; the generic runner owns HTTP,
environment bindings and execution. The dedicated SMTP service has been removed.

The full protocol suite is in [[../../tests/activepieces-mail/README|mail acceptance]].
