# Ticker: POST /poke wakes a sweep (see main.ts for the contract).
FROM denoland/deno:alpine-2.3.7@sha256:bec860a253508d9813bb622be2359fd7bb3f72ff9a85ed6f8ccd46ab8522bcf6

WORKDIR /app
COPY deno.json deno.lock due.ts main.ts ./
RUN deno cache main.ts

CMD ["run", "--allow-net", "--allow-env", "main.ts"]
