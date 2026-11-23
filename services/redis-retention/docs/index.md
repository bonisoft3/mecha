# Redis stream retention

The [[../Dockerfile]] packages the worker and Lua scripts on a digest-pinned Redis image. Deployment uses the built image; development updates use Compose `develop.watch`, not a source bind mount.

`run.sh` registers `EXPECTED_GROUPS` before its retention loop. Set `REDIS_URL`, `STREAM`, `EXPECTED_GROUPS` and `BOOTSTRAP_GROUPS`; group lists are comma-separated. `BOOTSTRAP_GROUPS` must be an explicitly set subset of expected groups whose consumers can recover from a snapshot; it may be empty. A missing group on a stream with evidence of prior deletion is rejected unless listed in `BOOTSTRAP_GROUPS`. Existing groups are never changed. Registration must complete before publishers and consumers start.

`INTERVAL_SECONDS` defaults to 5 and `TRIM_LIMIT` to 10000 (maximum 10000). `MODE=plan` reports the boundary without trimming; `MODE=apply` is the default. Each successful pass emits JSON and updates `HEALTH_FILE` if set. A missing expected group stops the worker. Productive passes repeat after 100 ms; idle passes use the configured interval.

There is no age buffer. The atomic collector finds the minimum safe frontier across every actual group: its last delivered ID is inclusive, while its oldest pending ID is exclusive. An exclusive boundary wins a tie. Entries acknowledged by every consumer can be removed; unread and pending entries remain protected. A stalled group can retain the prefix behind it.

Each pass uses bounded approximate `XTRIM`, followed, when no node was removed, by exact deletion of at most `min(TRIM_LIMIT, 128)` eligible prefix entries. This clears even the final acknowledged entry without deleting the stream key or consumer groups. JSON reports `boundary`, `boundary_inclusive`, the constraining group, and trim counts. Cleanup remains available at Redis's memory limit.

Run the disposable Redis integration tests with:

```sh
python3 -m unittest discover -s libraries/mecha/services/redis-retention -v
```
