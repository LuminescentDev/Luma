#!/bin/zsh

set -euo pipefail

brew install node@22

export PATH="$(brew --prefix node@22)/bin:$HOME/.cargo/bin:$PATH"

npm install --global pnpm@11

curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |
  sh -s -- -y --profile minimal --default-toolchain none

rustup toolchain install 1.93.1 --profile minimal
rustup target add \
  --toolchain 1.93.1 \
  aarch64-apple-ios \
  aarch64-apple-ios-sim \
  x86_64-apple-ios

cd "${CI_PRIMARY_REPOSITORY_PATH:?}"
pnpm install --frozen-lockfile
