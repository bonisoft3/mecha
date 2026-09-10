FROM rclone/rclone:1.71.0@sha256:fd635aecd9667ee3c3bf920d14118090d4f2a83a080c1fa77e0bafbd4587ca87
USER root
RUN mkdir -p /data && chown -R 1000:1000 /data
COPY services/rclone-s3/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
USER 1000
ENTRYPOINT ["/entrypoint.sh"]
