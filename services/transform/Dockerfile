# rpk Connect (Benthos) bloblang pipelines.
# Single image carrying all pipeline definitions; the compose service
# selects which one to run via `command:` override.
FROM redpandadata/connect:4.46.0@sha256:f84ebd666931dc667b8b33c70900ff49a34c73d1811b096f668e360d66a05d4c

COPY services/transform/passthrough.yaml /pipelines/passthrough.yaml
COPY services/transform/kafka-fanout.yaml /pipelines/kafka-fanout.yaml

CMD ["run", "/pipelines/passthrough.yaml"]
