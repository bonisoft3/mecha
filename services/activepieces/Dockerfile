# generated from build.cue — do not edit
FROM denoland/deno:debian-2.9.7@sha256:fa335acdf6b72106eda2cb6a8cb5f4187e7630e357467489db4b2e7352d5e432 AS activepieces-image
WORKDIR /runner
COPY main.ts runner.ts child.ts deno.json deno.lock /runner/
RUN deno cache --frozen --config /runner/deno.json /runner/main.ts /runner/child.ts
EXPOSE 8080
CMD ["run", "--frozen", "--cached-only", "--config=/runner/deno.json", "--allow-env", "--allow-read", "--allow-net", "--allow-run", "/runner/main.ts"]
