#!/bin/zsh

set -euo pipefail

if [[ "${CI_XCODE_CLOUD:-}" != "TRUE" ]]; then
  exit 0
fi

repository_path="${CI_PRIMARY_REPOSITORY_PATH:?}"
apple_path="${repository_path}/apps/desktop/src-tauri/gen/apple"
config_path="${repository_path}/apps/desktop/src-tauri/tauri.conf.json"
build_number="${CI_BUILD_NUMBER:?}"

# main always carries the last *released* version, which App Store Connect refuses
# to accept a second time. The open release-please PR holds the version this build
# will become, so prefer it and fall back to main for the window between a release
# merge and the PR that follows it.
release_branch="release-please--branches--main--components--luma"
pending_config="$(mktemp -t luma-pending-tauri-conf)"
trap 'rm -f "${pending_config}"' EXIT

if curl --fail --silent --location --retry 3 --max-time 30 \
  --output "${pending_config}" \
  "https://raw.githubusercontent.com/bwmp-dev/Luma/${release_branch}/apps/desktop/src-tauri/tauri.conf.json"; then
  version_path="${pending_config}"
else
  version_path="${config_path}"
fi

marketing_version="$(/usr/bin/plutil -extract version raw "${version_path}")"
echo "Building ${marketing_version} (${build_number}) from ${version_path}"

# tauri.conf.json is read when the Rust library compiles later in this build, so
# patching it here keeps the app's own `getVersion()` in step with the bundle.
/usr/bin/sed -i '' -E \
  "s/(\"version\"[[:space:]]*:[[:space:]]*)\"[^\"]+\"/\1\"${marketing_version}\"/" \
  "${config_path}"

applied_version="$(/usr/bin/plutil -extract version raw "${config_path}")"
if [[ "${applied_version}" != "${marketing_version}" ]]; then
  echo "Could not set the version in ${config_path}" >&2
  exit 1
fi

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
