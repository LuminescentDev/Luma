#!/bin/zsh

set -euo pipefail

if [[ "${CI_XCODE_CLOUD:-}" != "TRUE" ]]; then
  exit 0
fi

repository_path="${CI_PRIMARY_REPOSITORY_PATH:?}"
plist_path="${repository_path}/apps/desktop/src-tauri/gen/apple/luma_iOS/Info.plist"
marketing_version="$(
  /usr/bin/plutil -extract version raw \
    "${repository_path}/apps/desktop/src-tauri/tauri.conf.json"
)"
build_number="${CI_BUILD_NUMBER:?}"

/usr/libexec/PlistBuddy \
  -c "Set :CFBundleShortVersionString ${marketing_version}" \
  -c "Set :CFBundleVersion ${build_number}" \
  "${plist_path}"
