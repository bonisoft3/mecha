-- vim: set filetype=sql:
-- Windowed aggregation: concatenate hello messages arriving within a window.
-- Source: flat entity events from rpk via Kafka/Redpanda (at-least-once).
-- Deduplicates by id within each window to handle CDC amplification.

-- Source: read flat entity events from Redpanda via Kafka protocol
CREATE TABLE hello_events (
    id TEXT,
    message TEXT,
    operation TEXT,
    collection TEXT,
    traceparent TEXT
) WITH (
    type = 'source',
    connector = 'kafka',
    bootstrap_servers = 'redpanda:9092',
    topic = 'flat-Hello',
    format = 'json',
    'source.offset' = 'earliest'
);

-- Sink: write aggregated results to PostgREST (GroupHello table)
CREATE TABLE grouphello_output (
    messages TEXT
) WITH (
    connector = 'webhook',
    endpoint = 'http://crud:3000/GroupHello',
    headers = 'Content-Type:application/json',
    format = 'json'
);

-- Tumbling 30s window: collect distinct messages by id, emit when >= 2 unique records
INSERT INTO grouphello_output
SELECT
    string_agg(message, ', ') as messages
FROM (
    SELECT DISTINCT id, message
    FROM hello_events
    WHERE operation = 'create' AND collection = 'Hello'
)
GROUP BY hop(interval '30' second, interval '30' second)
HAVING COUNT(*) >= 2;
