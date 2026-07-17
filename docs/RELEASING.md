# Releasing Luma

Release Please maintains a release pull request from Conventional Commits on
`main`. The pull request updates `CHANGELOG.md` and keeps the versions in
`package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` in sync.
Merging it causes the same workflow to create a draft GitHub Release and
matching `v*` tag, then build Windows, macOS, and Linux bundles. It signs the
Tauri updater artifacts, creates `latest.json`, generates `SHA256SUMS`, and
publishes all assets to the release.

## Release Please configuration

The workflow uses the built-in `GITHUB_TOKEN`; no separate Release Please token
is required. Repository Actions settings must allow GitHub Actions to create and
approve pull requests.

Use Conventional Commit prefixes when merging changes:

- `fix:` produces a patch release.
- `feat:` produces a minor release.
- A `BREAKING CHANGE:` footer or `!` marker produces a major release.

Release Please creates releases as drafts and forces tag creation immediately.
Do not publish the draft manually; the checksum job publishes it only after all
artifacts and updater signatures have been verified.

## Updater signing configuration

Generate and protect a Tauri updater signing key pair according to the Tauri 2
updater documentation. Configure these GitHub repository settings:

- Secret `TAURI_SIGNING_PRIVATE_KEY`: the private updater signing key.
- Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the private key password.
- Variable `TAURI_UPDATER_PUBLIC_KEY`: the complete public key generated from
  the same key pair.

The checked-in `src-tauri/tauri.conf.json` deliberately contains
`PLACEHOLDER_CI_INJECTS_TAURI_UPDATER_PUBLIC_KEY` and an `OWNER` release URL.
The Release Please workflow replaces both values on the CI runner before
compilation.
The injected public key must match `TAURI_SIGNING_PRIVATE_KEY`; otherwise clients
will reject downloaded update artifacts. Never commit the private key or its
password.

The release remains a draft until all platform builds finish and the checksum
job verifies that `latest.json` and at least one `.sig` asset exist. The checksum
job hashes every downloaded release asset, uploads `SHA256SUMS`, and then
publishes the release.
