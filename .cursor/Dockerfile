FROM node:26.7.0-bookworm

ARG PNPM_VERSION=11.22.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends jq sudo \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "pnpm@${PNPM_VERSION}" \
    && printf 'node ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/node \
    && chmod 0440 /etc/sudoers.d/node

USER node
WORKDIR /workspace
