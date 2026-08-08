FROM docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584
COPY product /opt/kanthord
RUN chmod +x /opt/kanthord/dist/main.js && ln -s /opt/kanthord/dist/main.js /usr/local/bin/kanthord
COPY bin/kanthordc /usr/local/bin/kanthordc
RUN chmod +x /usr/local/bin/kanthordc
COPY bin/write-config.mjs /opt/e2e/bin/write-config.mjs
COPY bin/e2e-request.mjs /opt/e2e/bin/e2e-request.mjs
WORKDIR /var/lib/kanthord
