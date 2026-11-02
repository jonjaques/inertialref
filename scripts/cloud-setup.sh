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
# It exists for two reasons. **Cloud session images ship Node 20, 21 and 22, and this
# repository needs Node 26.** That is not a preference. `pnpm sim`, vitest and the headless
# runner execute the TypeScript sources directly through type stripping with no build step,
# so an older runtime does not degrade — it fails at the first import. A SessionStart hook
# cannot fix it, because a hook cannot change PATH for the commands that run after it.
# And **the clone holds LFS pointers**, while the hull models are LFS content: the image
# ships git-lfs with its smudge skipped, so `hullClearance.test.ts` fails at collection
# and a bundle ships a 130-byte file where the ship should be. The clone happens before
# this script runs, so nothing here can fetch the objects into it —
# .claude/hooks/session-start.sh pulls the ones the clone left as pointers, and says so
# when the pull fails. This script only makes sure the filter is installed system-wide.
#
# Dependencies are deliberately NOT installed here: .claude/hooks/session-start.sh does
# that on every session, cloud and local, and it takes ~3s.
#
# Constraints this is written around (from the cloud-environments docs):
#   * must exit zero, or the session fails to start — hence `|| true` and the final exit 0;
#   * must finish inside ~5 minutes for the snapshot to build;
#   * needs Trusted network access. nodejs.org, registry.npmjs.org and archive.ubuntu.com
#     are all on the default allowlist, so no extra domains are required;
#   * the environment's variables are not set yet when it runs, and `gh pr` and every
#     other GraphQL subcommand answer 403 through the GitHub proxy for the whole session —
#     the `/ship` skill carries the `gh api` REST forms.

set -uo pipefail

# Guarded rather than redirected: with the file absent it is the redirect that fails,
# before `tr` or its `2>/dev/null` exist, and the shell's own "No such file" lands in the
# setup log. The script may well run outside the clone; 26 is the pinned major today.
NODE_MAJOR=26
[ -f .node-version ] && NODE_MAJOR=$(tr -d '[:space:]' <.node-version)

# The version package.json pins in `packageManager`, read with the Node the image has.
# Any pnpm from 10 on re-executes the pinned version itself, so a stale fallback costs one
# download at first use rather than a mismatch — but the fallback is still worth keeping
# current, because that download is the one thing a cached environment never skips.
PNPM_VERSION=$(node -p "require('./package.json').packageManager.split('@')[1]" 2>/dev/null || echo 12.14.0)

# git-lfs, for the reason in the header. `--system` because the script runs as root and
# the session does not; a `--local` install would also be skipped by every worktree
# Claude Code creates, which neutralizes the repository's own filter drivers on purpose.
# `--skip-smudge` because `git lfs install` also sets `filter.lfs.required`: a smudge that
# cannot reach the LFS server through the proxy then fails the checkout outright, where a
# skipped one leaves a pointer the SessionStart hook pulls and reports on. The image's
# `check-tools` asks for the same `--skip`. The cost is a branch switched to mid-session,
# whose changed models stay pointers until `git lfs pull`. The image carries git-lfs
# already, so apt runs only on an image that does not.
(command -v git-lfs >/dev/null || { apt-get update -qq && apt-get install -y -qq git-lfs; }) >/dev/null 2>&1 &&
  git lfs install --system --skip-smudge >/dev/null 2>&1 ||
  echo "git-lfs install failed; the model files will be pointers until 'git lfs pull' runs" >&2

case "$(uname -m)" in
  x86_64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) echo "Unsupported architecture $(uname -m); leaving the image's Node in place" >&2; exit 0 ;;
esac

# Resolve the current Node 26 patch release rather than pinning one that will go stale.
# SHASUMS256.txt is a few KB and names every artifact for the release, so one request
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
# The same directory carries the image's own pnpm 10, which shadows ours the same way.
SHADOW_DIR=$(dirname "$(command -v node 2>/dev/null || echo /usr/local/bin/node)")
for target in /usr/local/bin "$SHADOW_DIR"; do
  [ -d "$target" ] || continue
  for bin in node npm npx; do
    ln -sf "/opt/node${NODE_MAJOR}/bin/${bin}" "${target}/${bin}" 2>/dev/null || true
  done
done
echo "export PATH=/opt/node${NODE_MAJOR}/bin:\$PATH" > /etc/profile.d/node"${NODE_MAJOR}".sh

# pnpm, at the version pinned in package.json's packageManager field. Installed explicitly
# rather than through corepack, which is no longer bundled with current Node releases.
"/opt/node${NODE_MAJOR}/bin/npm" install -g "pnpm@${PNPM_VERSION}" >/dev/null 2>&1 || true
for target in /usr/local/bin "$SHADOW_DIR"; do
  [ -d "$target" ] || continue
  ln -sf "/opt/node${NODE_MAJOR}/bin/pnpm" "${target}/pnpm" 2>/dev/null || true
done

echo "Installed Node ${VERSION} and pnpm ${PNPM_VERSION}."
echo "node -> $(node -v 2>/dev/null || echo 'not resolving; check PATH order')"
echo "pnpm -> $(pnpm -v 2>/dev/null || echo 'not resolving; check PATH order')"
echo "git-lfs -> $(git lfs version 2>/dev/null || echo 'not installed')"

exit 0
