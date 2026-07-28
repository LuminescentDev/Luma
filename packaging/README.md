# Distribution packaging

GitHub Releases are the signed upstream source for every package in this
directory. Generate manifests for an already-published release with:

```sh
node scripts/update-distribution-manifests.mjs 0.14.2
```

The updater verifies that the expected release artifacts exist and uses their
published `SHA256SUMS` entries. Commit its output only after the release is
public.

## WinGet

The generated multi-file manifest is under `winget/manifests`. Validate it on
Windows:

```powershell
winget validate .\packaging\winget\manifests\b\BWMP\Luma\0.14.2
```

For the first release, fork `microsoft/winget-pkgs`, copy the version directory
into the matching `manifests/b/BWMP/Luma` path, test it in Windows Sandbox, and
open a pull request. After acceptance, later versions can be submitted with
WinGetCreate:

```powershell
wingetcreate update BWMP.Luma --version 0.14.2 --urls `
  https://github.com/bwmp-dev/Luma/releases/download/v0.14.2/Luma_0.14.2_x64-setup.exe
```

## Arch User Repository

Create the `luma-bin` package on the AUR, clone its SSH repository, and copy
`aur/PKGBUILD` and `aur/.SRCINFO` into it. The recipe installs the upstream
Debian payload and declares its native Arch runtime dependencies.

Before pushing an update, test it in a clean Arch environment:

```sh
makepkg --syncdeps --cleanbuild
namcap PKGBUILD luma-bin-*.pkg.tar.zst
makepkg --printsrcinfo > .SRCINFO
git push
```

An AUR account with an uploaded SSH public key is required. The AUR accepts only
the package recipe; do not commit release binaries to its repository.

## Homebrew

The cask currently supports Apple silicon only because the upstream release
contains only an `aarch64` DMG. Copy `homebrew/Casks/luma.rb` into a
`bwmp-dev/homebrew-tap` repository so users can install it with:

```sh
brew install --cask bwmp-dev/tap/luma
```

Validate before publishing:

```sh
brew audit --cask --strict packaging/homebrew/Casks/luma.rb
brew install --cask packaging/homebrew/Casks/luma.rb
brew uninstall --cask luma
```

Do not claim Intel support until the release workflow publishes a signed,
notarized x86_64 or universal DMG.

## Snap Store

The generated `snap/snapcraft.yaml` repackages the upstream Debian artifact.
Luma needs classic confinement for host shells, arbitrary SSH files, and serial
workflows, so the Snap Store must approve classic confinement before a stable
release can be published.

```sh
cd packaging/snap
snapcraft
snapcraft upload --release=edge luma_0.14.2_amd64.snap
```

Register the `luma` name and authenticate with a Snapcraft account first.
Promote a tested revision from `edge` to `stable` in the Snapcraft dashboard.

## Flatpak

The Flatpak manifest is for direct testing and distribution, not an automated
Flathub submission. It repackages the upstream Debian artifact and grants broad
filesystem/device permissions required by Luma. Local terminal sessions run
inside the Flatpak environment; remote SSH and SFTP remain the primary supported
workflows.

```sh
flatpak install --user flathub org.gnome.Platform//49 org.gnome.Sdk//49
flatpak-builder --force-clean --user --install build-flatpak \
  packaging/flatpak/dev.bwmp.luma.yml
flatpak run dev.bwmp.luma
```

Build a distributable single-file bundle:

```sh
flatpak-builder --force-clean --repo=flatpak-repo build-flatpak \
  packaging/flatpak/dev.bwmp.luma.yml
flatpak build-bundle flatpak-repo Luma.flatpak dev.bwmp.luma
```

Do not submit these generated files to Flathub without personally reviewing its
current submission, stability, source-build, sandbox, and generative-AI
policies. A compliant Flathub package would need a separate offline source build
and a deliberate design for host terminal access.

## Release checklist

1. Publish the signed GitHub Release and `SHA256SUMS`.
2. Run the manifest updater with the released version.
3. Run the `Distribution packages` workflow to validate and build channel
   artifacts.
4. Test every package on a clean target system.
5. Submit WinGet and AUR updates and update the Homebrew tap.
6. Upload the Snap to `edge`, test it, then promote it.
7. Publish the Flatpak bundle through a repository you control if desired.
8. Add website installation commands only after each channel is live.

## Automation credentials

The manually dispatched `Distribution packages` workflow always generates and
validates manifests. Its publishing switches default to `false`. Configure only
the secrets for channels you intend to publish:

| Secret | Used for |
| --- | --- |
| `AUR_SSH_PRIVATE_KEY` | SSH key registered to the maintainer of the existing `luma-bin` AUR package |
| `DISTRIBUTION_GITHUB_TOKEN` | Push access to the existing `bwmp-dev/homebrew-tap` repository |
| `WINGET_CREATE_GITHUB_TOKEN` | WinGetCreate PR submission after `BWMP.Luma` is accepted initially |
| `SNAPCRAFT_STORE_LOGIN` | Exported Snapcraft login authorized for the registered `luma` name |

Create the AUR package, Homebrew tap, first WinGet submission, and Snap Store
name manually before enabling their corresponding publishing switches. Protect
the workflow with a GitHub environment if release publication requires an
additional human approval in repository settings.
