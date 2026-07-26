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

export RUST_BACKTRACE=1
export CFLAGS_aarch64_apple_ios="-isysroot ${SDKROOT:?}"
export CXXFLAGS_aarch64_apple_ios="-isysroot ${SDKROOT}"
export OBJC_INCLUDE_PATH_aarch64_apple_ios="${SDKROOT}/usr/include"

cargo_args=(
  build
  --locked
  --manifest-path "${tauri_path}/Cargo.toml"
  --target aarch64-apple-ios
  --lib
)
profile=debug
if [[ "${CONFIGURATION:?}" == "release" ]]; then
  cargo_args+=(--release)
  profile=release
fi

cargo "${cargo_args[@]}"

library_path="${tauri_path}/target/aarch64-apple-ios/${profile}/libluma_lib.a"
output_path="${SRCROOT:?}/Externals/arm64/${CONFIGURATION}/libapp.a"

if [[ ! -f "${library_path}" ]]; then
  echo "Rust static library was not produced at ${library_path}" >&2
  exit 1
fi

mkdir -p "$(dirname "${output_path}")"
cp "${library_path}" "${output_path}"
