# Releasing Luma

Release builds are created by `.github/workflows/release.yml` when a tag matching
`v*` is pushed. The workflow builds Windows, macOS, and Linux bundles, signs the
Tauri updater artifacts, creates `latest.json`, generates `SHA256SUMS`, and
publishes all assets to the matching GitHub Release.

## Updater signing configuration

Generate and protect a Tauri updater signing key pair according to the Tauri 2
updater documentation. Configure these GitHub repository settings:

- Secret `TAURI_SIGNING_PRIVATE_KEY`: the private updater signing key.
- Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the private key password.
- Variable `TAURI_UPDATER_PUBLIC_KEY`: the complete public key generated from
  the same key pair.

The checked-in `src-tauri/tauri.conf.json` deliberately contains
`PLACEHOLDER_CI_INJECTS_TAURI_UPDATER_PUBLIC_KEY` and an `OWNER` release URL.
The release workflow replaces both values on the CI runner before compilation.
The injected public key must match `TAURI_SIGNING_PRIVATE_KEY`; otherwise clients
will reject downloaded update artifacts. Never commit the private key or its
password.

The release remains a draft until all platform builds finish and the checksum
job verifies that `latest.json` and at least one `.sig` asset exist. The checksum
job hashes every downloaded release asset, uploads `SHA256SUMS`, and then
publishes the release.
