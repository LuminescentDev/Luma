#!/bin/zsh

set -euo pipefail

if [[ "${CI_XCODE_CLOUD:-}" != "TRUE" ]]; then
  exit 0
fi

repository_path="${CI_PRIMARY_REPOSITORY_PATH:?}"
apple_path="${repository_path}/apps/desktop/src-tauri/gen/apple"
marketing_version="$(
  /usr/bin/plutil -extract version raw \
    "${repository_path}/apps/desktop/src-tauri/tauri.conf.json"
)"
build_number="${CI_BUILD_NUMBER:?}"

# The Live Activity extension must carry the same version as its host app or the
# App Store rejects the upload.
for plist_path in \
  "${apple_path}/luma_iOS/Info.plist" \
  "${apple_path}/LumaLiveActivityExtension/Info.plist"; do
  /usr/libexec/PlistBuddy \
    -c "Set :CFBundleShortVersionString ${marketing_version}" \
    -c "Set :CFBundleVersion ${build_number}" \
    "${plist_path}"
done
