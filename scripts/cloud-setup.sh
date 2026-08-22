#!/usr/bin/env bash
#
# Setup script for a Claude Code cloud environment.
#
# THIS FILE IS NOT RUN BY THE REPOSITORY. Paste its contents into the **Setup script**
# field of a cloud environment at claude.ai/code (Add cloud environment, or the settings
# icon on an existing one). It runs as root on Ubuntu 24.04 before Claude Code launches,
# and the resulting filesystem is snapshotted — so it runs once, and every later session in
# that environment starts with Node 26 already on disk. It is committed here so the
# environment's configuration is reviewable and reproducible rather than living only in a
# text box.
#
# It exists for one reason: **cloud session images ship Node 20, 21 and 22, and this
# repository needs Node 26.** That is not a preference. `pnpm sim`, vitest and the headless
# runner execute the TypeScript sources directly through type stripping with no build step,
# so an older runtime does not degrade — it fails at the first import. A SessionStart hook
# cannot fix it, because a hook cannot change PATH for the commands that run after it.
#
# Dependencies are deliberately NOT installed here: .claude/hooks/session-start.sh does
# that on every session, cloud and local, and it takes ~3s.
#
# Constraints this is written around (from the cloud-environments docs):
#   * must exit zero, or the session fails to start — hence `|| true` and the final exit 0;
#   * must finish inside ~5 minutes for the snapshot to build;
#   * needs Trusted network access. nodejs.org and registry.npmjs.org are both on the
#     default allowlist, so no extra domains are required.

set -uo pipefail

NODE_MAJOR=$(tr -d '[:space:]' < .node-version 2>/dev/null || echo 26)
PNPM_VERSION=11.22.0

case "$(uname -m)" in
  x86_64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) echo "Unsupported architecture $(uname -m); leaving the image's Node in place" >&2; exit 0 ;;
esac

# Resolve the current Node 26 patch release rather than pinning one that will go stale.
# SHASUMS256.txt is a few KB and names every artefact for the release, so one request
# answers "what is the latest v26" without downloading the 1 MB dist index.
TARBALL=$(curl -fsSL --max-time 60 "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" 2>/dev/null \
  | grep -o "node-v${NODE_MAJOR}\.[0-9.]*-linux-${ARCH}\.tar\.xz" | head -1)

if [ -z "$TARBALL" ]; then
  echo "Could not resolve a Node ${NODE_MAJOR} release from nodejs.org; leaving the image's Node in place" >&2
  exit 0
fi

VERSION=${TARBALL#node-}
VERSION=${VERSION%%-linux*}

curl -fsSL --max-time 240 "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/${TARBALL}" -o /tmp/node.tar.xz || {
  echo "Node ${VERSION} download failed; leaving the image's Node in place" >&2
  exit 0
}

mkdir -p /opt/node"${NODE_MAJOR}"
tar -xJf /tmp/node.tar.xz -C /opt/node"${NODE_MAJOR}" --strip-components=1 || {
  echo "Node ${VERSION} extraction failed; leaving the image's Node in place" >&2
  exit 0
}
rm -f /tmp/node.tar.xz

# The image puts Node 22 on PATH from /opt/node22/bin, which may sit ahead of
# /usr/local/bin — so symlinking into /usr/local/bin alone is not enough to win. Link into
# whichever directory currently owns `node` as well, and prepend ours for login shells.
for target in /usr/local/bin "$(dirname "$(command -v node 2>/dev/null || echo /usr/local/bin/node)")"; do
  [ -d "$target" ] || continue
  for bin in node npm npx; do
    ln -sf "/opt/node${NODE_MAJOR}/bin/${bin}" "${target}/${bin}" 2>/dev/null || true
  done
done
echo "export PATH=/opt/node${NODE_MAJOR}/bin:\$PATH" > /etc/profile.d/node"${NODE_MAJOR}".sh

# pnpm, at the version pinned in package.json's packageManager field. Installed explicitly
# rather than through corepack, which is no longer bundled with current Node releases.
"/opt/node${NODE_MAJOR}/bin/npm" install -g "pnpm@${PNPM_VERSION}" >/dev/null 2>&1 || true
for target in /usr/local/bin; do
  ln -sf "/opt/node${NODE_MAJOR}/bin/pnpm" "${target}/pnpm" 2>/dev/null || true
done

echo "Installed Node ${VERSION} and pnpm ${PNPM_VERSION}."
echo "node -> $(node -v 2>/dev/null || echo 'not resolving; check PATH order')"
echo "pnpm -> $(pnpm -v 2>/dev/null || echo 'not resolving; check PATH order')"

exit 0
