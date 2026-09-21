# Multilingual data paths

The ground: [`../README.md`](../README.md)
(the 3-path data flow: CRUD, CDC, and Sync; Invariant 3: at-least-once delivery with sink
idempotency; Invariant 5: stateless processing, stateful storage),
[`2026-09-08-a-tick-needs-no-durability.md`](2026-09-08-a-tick-needs-no-durability.md)
(the scheduler and CDC guarantees), and [`../../../guis/iris`](../../../guis/iris),
whose [`../../../guis/iris/services/transform/pipelines/translate.yaml`](../../../guis/iris/services/transform/pipelines/translate.yaml)
and [`../../../guis/iris/server/utils/translate.ts`](../../../guis/iris/server/utils/translate.ts)
ran translation on the CDC path in production.

The claim: **dynamic content localization is governed by Mecha's three paths
without exception: the CRUD path accepts writes synchronously in the author's language;
the CDC path asynchronously translates rows via stateless stream pipelines into durable
translation tables with sink idempotency; and the Sync path projects non-blocking joined
views to clients via live query. Eager fan-out across all supported languages upon every
insert is refused for user-generated content: it wastes 80–90% of translation compute on
locales nobody reads. Translation is route-driven (lazy) by default: accessing or
pre-fetching a route reading an untranslated row under a given locale synthesizes the
translation demand on the backend. The client never micromanages item-level translation
queues.**

## Facts not to re-derive

Read out of the PostgreSQL engine and measured in `guis/iris` on 2026-09-09.

- **Eager fan-out is combinatorially wasteful.** An app supporting 6 languages (`en`, `es`,
  `pt`, `ru`, `he`, `kk`) that translates eagerly runs 5 LLM inference calls for every
  inserted row. In user-facing apps, over 90% of user-generated content is only ever
  viewed by readers speaking the author's language or the primary lingua franca. Eager
  translation burns GPU/API tokens translating local chatter into Kazakh and Hebrew
  that zero users ever request.
- **Item-level client tracking is an architectural mistake.** Having the frontend loop
  over rendered rows, track sets of in-flight translation IDs, and emit ad-hoc batch POSTs
  breaks the boundary between presentation and data. The route is the transaction
  boundary. A read query for a route carries `Accept-Language: es`; the backend knows
  what the route needs.
- **PostgREST sink idempotency is mandatory.**
  `libraries/mecha/README.md:35`: "every entity table has a UNIQUE constraint on its
  request ID column. PostgREST sinks use `Prefer: resolution=ignore-duplicates` to absorb
  duplicate CDC events at the database level." When multiple readers access or pre-fetch
  the same route in Spanish, demand synthesizes `(item_id, 'es')` once. Duplicate
  deliveries or concurrent pokes collapse into no-ops at the database level.
- **Operating system collations diverge.** Glibc on Linux, Apple's Darwin on macOS, and
  musl on Alpine sort strings differently when using OS locales (`en_US.UTF-8`). A database
  using system collations produces divergent orderings across dev, CI, and Cloud Run.
  Postgres 15+ built with ICU (`COLLATE "und-x-icu"`) provides deterministic, platform-independent
  Unicode Collation Algorithm (UCA) ordering across all environments.
- **Full-text search requires per-language lexemes.** A single `tsvector` column cannot
  index Russian, Portuguese, and English text simultaneously without corrupting word
  stems. Postgres's `to_tsvector()` requires an explicit dictionary configuration
  (`pg_catalog.english`, `pg_catalog.portuguese`, `pg_catalog.russian`) matching the
  row's language.

---

## The Three Paths: Route-Driven Architecture

```
  1. Author writes item (pt) ──> [CRUD path] ──> items (pt) ──> commits (<10ms)
                                                     │
                                                     ▼
  2. Spanish reader accesses or pre-fetches route ─> [Sync path] ──> Live query serves original (pt) immediately
          │ (Accept-Language: es)                    ▲
          ▼                                          │
  3. Server detects missing (item, es)               │
     Inserts demand into translation_queue           │
          │                                          │
          ▼ [CDC path]                               │ 5. Sync path pushes Spanish translation
     Redpanda Connect (Benthos)                      │    delta reactively to reader
          │                                          │
          ▼ calls Gemini / Ollama for (es) only      │
     Writes item_translations (item, es) ────────────┘
```

### 1. Ingress (CRUD Path)
The author writes in their own language. The write commits immediately to `items`.
No translation runs; response time is `<10ms`.

### 2. Route Access & Server Demand Synthesis (Sync Path)
When a reader accesses or pre-fetches a route (e.g. `GET /items?id=eq.42` or a view) with
`Accept-Language: es`:

1. **Immediate Fallback**: The query coalesces existing translations with the source text:
   `coalesce(translations.caption, items.caption)`. The client receives the response
   instantly; the read is never blocked waiting for translation.
2. **Read-Through Demand Enqueue**: If the Spanish translation is missing, the backend
   read-through function enqueues the demand row without blocking the transaction:
   ```sql
   INSERT INTO item_translation_requests (item_id, language)
   VALUES (item.id, 'es')
   ON CONFLICT (item_id, language) DO NOTHING;
   ```
   If 100 users open the same screen simultaneously, `ON CONFLICT DO NOTHING` absorbs
   99 requests instantly. Exactly one translation task is queued.

### 3. Asynchronous Translation (CDC Path)
The CDC stream captures the insert on `item_translation_requests`. The Benthos pipeline
dispatches the translation worker for that specific `(item_id, language)` tuple:

```yaml
# services/transform/pipelines/translate.yaml
input:
  redis_streams:
    url: "redis://redis:6379"
    streams: ["cdc-events"]
    consumer_group: "mecha-translate"

pipeline:
  processors:
    - bloblang: |
        let row = this.data.parse_json().catch({})
        root = if $row.id != null && $row.item_id != null && $row.language != null {
          $row
        } else {
          deleted()
        }
    - http:
        url: http://mesh:3500/v1.0/invoke/translation-worker/method/translate
        verb: POST
        headers:
          Content-Type: application/json

output:
  http_client:
    url: http://caddy:8080/crud/item_translations
    verb: POST
    headers:
      Content-Type: application/json
      Prefer: "resolution=ignore-duplicates"
```

The translation worker translates *only* the requested language and writes back to
`item_translations`.

### 4. Route Pre-fetching Eliminates Perceived Latency
When the user views a parent list with links:
`<a href="#/items/42" data-prefetch>`:
- When the link enters the viewport or receives hover, Omnishell issues the route's read
  query ahead of time.
- That read query pokes the backend's read-through demand enqueue.
- By the time the user clicks the link and navigates to `#/items/42`, the translation
  worker has already populated `item_translations`. The reader sees the translated Spanish
  text on the very first frame.

---

## Database Schema Standards

### Table Definitions
```sql
CREATE TABLE items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_language text NOT NULL,
  caption text NOT NULL,
  disposal_instructions text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Durable cache of completed translations:
CREATE TABLE item_translations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  language text NOT NULL,
  caption text NOT NULL,
  disposal_instructions text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_item_translations_lang UNIQUE (item_id, language)
);

CREATE INDEX idx_item_translations_lookup ON item_translations (item_id, language);

-- Internal demand queue:
CREATE TABLE item_translation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  language text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_item_trans_req_item_lang UNIQUE (item_id, language)
);
```

### Deterministic ICU Collation
```sql
CREATE COLLATION IF NOT EXISTS unicode (provider = icu, locale = 'und-x-icu');
ALTER TABLE item_translations ALTER COLUMN caption TYPE text COLLATE unicode;
```

### Full-Text Search Vector
```sql
ALTER TABLE item_translations ADD COLUMN fts tsvector
  GENERATED ALWAYS AS (
    CASE language
      WHEN 'pt' THEN to_tsvector('pg_catalog.portuguese', caption)
      WHEN 'es' THEN to_tsvector('pg_catalog.spanish', caption)
      WHEN 'ru' THEN to_tsvector('pg_catalog.russian', caption)
      ELSE to_tsvector('pg_catalog.english', caption)
    END
  ) STORED;

CREATE INDEX idx_item_translations_fts ON item_translations USING gin (fts);
```
