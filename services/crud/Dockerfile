# PostgREST API with microcheck health probe and lazybox diagnostics toolkit.
FROM postgrest/postgrest:v12.2.3@sha256:0a46780309a604cdc8b56c776c6e5e15788ce58174d709e40459ab5a2d44d228

COPY --from=tarampampam/microcheck:1@sha256:79c187c05bfa67518078bf4db117771942fa8fe107dc79a905861c75ddf28dfa /bin/httpcheck /bin/httpcheck
COPY --from=bonitao/lazybox@sha256:2079599098bb80e8937f0d4fffb5a987644b61bd9dca67a17d03d1ef98fe5824 /lazybox/bin /usr/local/bin

CMD ["postgrest"]

HEALTHCHECK --interval=5s --timeout=5s --retries=12 --start-period=30s CMD ["httpcheck", "http://127.0.0.1:3001/ready"]
