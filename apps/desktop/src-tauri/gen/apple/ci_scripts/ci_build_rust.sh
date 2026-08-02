#!/bin/zsh

set -euo pipefail

repository_path="${CI_PRIMARY_REPOSITORY_PATH:?}"
desktop_path="${repository_path}/apps/desktop"
tauri_path="${desktop_path}/src-tauri"

if [[ "${ARCHS:?}" != "arm64" ]]; then
  echo "Unsupported Xcode Cloud architecture: ${ARCHS}" >&2
  exit 1
fi

pnpm --dir "${desktop_path}" apple:icon
pnpm --dir "${repository_path}" shared:build
pnpm --dir "${desktop_path}" build

# This directory is bundled as a folder reference, so anything left in it ships
# verbatim inside Luma.app. A stray Assets.car here gives the bundle a second
# compiled asset catalog and App Store processing marks the upload INVALID, so
# start from an empty directory rather than merging onto whatever was checked out.
assets_path="${SRCROOT:?}/assets"
rm -rf "${assets_path}"
mkdir -p "${assets_path}"
cp -R "${desktop_path}/dist/." "${assets_path}/"

export RUST_BACKTRACE=1
export CFLAGS_aarch64_apple_ios="-isysroot ${SDKROOT:?}"
export CXXFLAGS_aarch64_apple_ios="-isysroot ${SDKROOT}"
export OBJC_INCLUDE_PATH_aarch64_apple_ios="${SDKROOT}/usr/include"

# release-please bumps the version in Cargo.toml but has no updater for
# Cargo.lock, so release commits arrive with the two out of step and --locked
# refuses to build. --workspace confines the re-lock to the local packages, so
# every registry dependency stays pinned exactly as committed.
cargo update --workspace --manifest-path "${tauri_path}/Cargo.toml"

cargo_args=(
  build
  --locked
  --manifest-path "${tauri_path}/Cargo.toml"
  --target aarch64-apple-ios
  --lib
)
profile=debug
if [[ "${CONFIGURATION:?}" == "release" ]]; then
  # Without this the webview loads `build.devUrl` instead of the bundled assets.
  cargo_args+=(--release --features tauri/custom-protocol)
  profile=release
fi

# Optional analytics overrides, set as Xcode Cloud environment variables. The
# script runs under `set -u`, so the defaults are load-bearing; empty keeps the
# endpoint baked into the source.
export LUMA_ANALYTICS_HOST="${LUMA_ANALYTICS_HOST:-}"
export LUMA_ANALYTICS_KEY="${LUMA_ANALYTICS_KEY:-}"

cargo "${cargo_args[@]}"

library_path="${tauri_path}/target/aarch64-apple-ios/${profile}/libluma_lib.a"
output_path="${SRCROOT:?}/Externals/arm64/${CONFIGURATION}/libapp.a"

if [[ ! -f "${library_path}" ]]; then
  echo "Rust static library was not produced at ${library_path}" >&2
  exit 1
fi

mkdir -p "$(dirname "${output_path}")"
cp "${library_path}" "${output_path}"
