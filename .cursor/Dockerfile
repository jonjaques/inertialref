# Cursor Cloud Agent image. Node 26 is required for type stripping; the
# Debian packages below are required because Cursor clones, smudges LFS,
# and runs `terminals` *inside* this container — not beside it.
#
# Do not COPY the repository. Cursor checks out the requested commit after
# the image builds. Do not switch to `-slim`: git, python3 and a compiler
# would vanish, and the next failure would look like a product bug.
FROM node:26.7.0-bookworm

ARG PNPM_VERSION=11.22.0

# LANG is set after locale-gen. Setting it first makes apt print
# "Setting locale failed" on every package, which looks like a failed Build.
ENV DEBIAN_FRONTEND=noninteractive

# git: Cloud Agents clone inside the image. Missing git fails as "unexpected error".
# git-lfs: `*.glb` is LFS. Without it the hull is a 133-byte pointer and the
#          renderer silently falls back to the debug cone.
# tmux: environment.json terminals run in a tmux session Cursor shares with the agent.
# locales: session init expects en_US.UTF-8. POSIX LANG is how a custom image
#          builds, then fails to open.
# xz-utils: the same init unpacks with xz.
# sudo, jq: passwordless sudo for `node`; jq is the SessionStart hook.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        git-lfs \
        jq \
        locales \
        sudo \
        tmux \
        xz-utils \
    && printf 'en_US.UTF-8 UTF-8\n' > /etc/locale.gen \
    && locale-gen \
    && git lfs install --system \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "pnpm@${PNPM_VERSION}" \
    && printf 'node ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/node \
    && chmod 0440 /etc/sudoers.d/node

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8

USER node
WORKDIR /workspace
