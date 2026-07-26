#!/bin/zsh

set -euo pipefail

brew install node@22

export PATH="$(brew --prefix node@22)/bin:$HOME/.cargo/bin:$PATH"

npm install --global pnpm@11

rustup_init="$(mktemp -t luma-rustup-init)"
trap 'rm -f "${rustup_init}"' EXIT

curl --proto '=https' --tlsv1.2 -sSf \
  --retry 5 \
  --retry-all-errors \
  --retry-delay 2 \
  --retry-max-time 120 \
  --output "${rustup_init}" \
  https://sh.rustup.rs
sh "${rustup_init}" -y --profile minimal --default-toolchain none

rustup toolchain install 1.93.1 --profile minimal
rustup target add \
  --toolchain 1.93.1 \
  aarch64-apple-ios \
  aarch64-apple-ios-sim \
  x86_64-apple-ios

cd "${CI_PRIMARY_REPOSITORY_PATH:?}"
pnpm install --frozen-lockfile
