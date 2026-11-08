# Mail acceptance

These tests run the standard [[../../pieces/mail/README|mail piece]] through the
[[../../services/activepieces/README|generic runner]]. Run `sayt build`, `sayt lint`,
`sayt test`, and `sayt integrate` from this directory. Docker provides local Mailpit
fixtures; no external mail is sent. Certificate/key fixtures are public test data.

For container acceptance, build the runner image and set `MAIL_IMAGE`:

```sh
docker build -t pronto-activepieces:test ../../services/activepieces
MAIL_IMAGE=pronto-activepieces:test sayt integrate
```

The harness builds a cached fixture layer for the selected standard piece. Tests
cover plain/HTML/calendar MIME hierarchy and decoded payloads, UTF-8 filenames,
identity, Bcc privacy, actual SMTP replies and recipient outcomes, single attempts,
authentication, trusted/untrusted TLS and (in the container) hostname mismatch.
pronto's `mecha-airlock.integration.test.ts` additionally exercises generated Compose and ledger delivery.
