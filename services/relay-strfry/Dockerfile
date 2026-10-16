# strfry with the SmartCity write policy. Build from the repository root after `pnpm --filter relay-strfry build`:
#   docker build -t smartcity-strfry services/relay-strfry
FROM ghcr.io/hoytech/strfry:latest
USER root
RUN apk add --no-cache nodejs
COPY dist/policy.mjs /app/smartcity-policy.mjs
COPY strfry.conf /etc/strfry.conf
RUN printf '#!/bin/sh\nexec node /app/smartcity-policy.mjs\n' > /app/smartcity-policy.sh && chmod +x /app/smartcity-policy.sh
RUN mkdir -p /app/strfry-db && chown strfry:strfry /app/strfry-db
USER strfry
VOLUME /app/strfry-db
EXPOSE 7777
ENTRYPOINT ["/app/strfry", "--config=/etc/strfry.conf"]
CMD ["relay"]
