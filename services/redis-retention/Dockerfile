FROM redis:7.4.1-alpine@sha256:59b6e694653476de2c992937ebe1c64182af4728e54bb49e9b7a6c26614d8933
COPY run.sh init.lua retain.lua /retention/
ENTRYPOINT ["sh", "/retention/run.sh"]
