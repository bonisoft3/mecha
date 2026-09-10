# Clock: the cadence that pokes the ticker. Config baked in, like transform's.
FROM redpandadata/connect:4.46.0@sha256:f84ebd666931dc667b8b33c70900ff49a34c73d1811b096f668e360d66a05d4c

COPY services/clock/clock.yaml /clock.yaml

CMD ["run", "/clock.yaml"]
