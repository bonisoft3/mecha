# WebAuthn passkey auth service (see main.ts for the endpoint contract).
FROM denoland/deno:alpine-2.3.7@sha256:bec860a253508d9813bb622be2359fd7bb3f72ff9a85ed6f8ccd46ab8522bcf6

WORKDIR /app
COPY deno.json deno.lock main.ts ./
RUN deno cache main.ts

CMD ["run", "--allow-net", "--allow-env", "main.ts"]
