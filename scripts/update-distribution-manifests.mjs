#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import process from "node:process";

const REPOSITORY = "bwmp-dev/Luma";
const WEBSITE = "https://luma.bwmp.dev";
const version = (process.argv[2] ?? "").replace(/^v/, "");

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("Usage: node scripts/update-distribution-manifests.mjs <version>");
}

const tag = `v${version}`;
const releaseBase = `https://github.com/${REPOSITORY}/releases/download/${tag}`;
const releaseApi = `https://api.github.com/repos/${REPOSITORY}/releases/tags/${tag}`;
const response = await fetch(releaseApi, {
  headers: {
    Accept: "application/vnd.github+json",
    "User-Agent": "luma-distribution-manifest-updater",
  },
});

if (!response.ok) {
  throw new Error(`GitHub release lookup failed: ${response.status} ${response.statusText}`);
}

const release = await response.json();
if (release.draft) {
  throw new Error(`${tag} is still a draft release`);
}

const assets = new Set(release.assets.map((asset) => asset.name));
const checksumsAsset = release.assets.find((asset) => asset.name === "SHA256SUMS");
if (!checksumsAsset) {
  throw new Error(`${tag} does not contain SHA256SUMS`);
}

const checksumsResponse = await fetch(checksumsAsset.browser_download_url);
if (!checksumsResponse.ok) {
  throw new Error(`Checksum download failed: ${checksumsResponse.status}`);
}

const checksums = new Map(
  (await checksumsResponse.text())
    .trim()
    .split(/\r?\n/u)
    .map((line) => {
      const match = line.match(/^([a-f0-9]{64})\s+(.+)$/u);
      if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`);
      return [match[2], match[1]];
    }),
);
const licenseUrl = `https://raw.githubusercontent.com/${REPOSITORY}/${tag}/LICENSE`;
const licenseResponse = await fetch(licenseUrl);
if (!licenseResponse.ok) {
  throw new Error(`License download failed: ${licenseResponse.status}`);
}
const licenseSha256 = createHash("sha256")
  .update(Buffer.from(await licenseResponse.arrayBuffer()))
  .digest("hex");

const artifact = {
  deb: `Luma_${version}_amd64.deb`,
  dmg: `Luma_${version}_aarch64.dmg`,
  exe: `Luma_${version}_x64-setup.exe`,
};

for (const [kind, name] of Object.entries(artifact)) {
  if (!assets.has(name)) throw new Error(`${tag} is missing the ${kind} artifact: ${name}`);
  if (!checksums.has(name)) throw new Error(`SHA256SUMS is missing ${name}`);
}

const output = new Map([
  [
    "packaging/aur/PKGBUILD",
    `# Maintainer: Luma contributors <luma@bwmp.dev>
pkgname=luma-bin
pkgver=${version}
pkgrel=1
pkgdesc="Free open-source terminal and SSH client"
arch=('x86_64')
url="${WEBSITE}"
license=('MIT')
depends=('gtk3' 'webkit2gtk-4.1' 'systemd-libs')
provides=('luma')
conflicts=('luma')
options=('!strip')
source=(
  "luma-\${pkgver}.deb::${releaseBase}/${artifact.deb}"
  "LICENSE-\${pkgver}::${licenseUrl}"
)
sha256sums=(
  '${checksums.get(artifact.deb)}'
  '${licenseSha256}'
)

package() {
  cd "$pkgdir"
  bsdtar -xf "$srcdir/luma-\${pkgver}.deb"
  bsdtar -xf data.tar.*
  rm control.tar.* data.tar.* debian-binary

  install -Dm644 "$srcdir/LICENSE-\${pkgver}" \
    "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
}
`,
  ],
  [
    "packaging/aur/.SRCINFO",
    `pkgbase = luma-bin
\tpkgdesc = Free open-source terminal and SSH client
\tpkgver = ${version}
\tpkgrel = 1
\turl = ${WEBSITE}
\tarch = x86_64
\tlicense = MIT
\tdepends = gtk3
\tdepends = webkit2gtk-4.1
\tdepends = systemd-libs
\tprovides = luma
\tconflicts = luma
\toptions = !strip
\tsource = luma-${version}.deb::${releaseBase}/${artifact.deb}
\tsource = LICENSE-${version}::${licenseUrl}
\tsha256sums = ${checksums.get(artifact.deb)}
\tsha256sums = ${licenseSha256}

pkgname = luma-bin
`,
  ],
  [
    "packaging/homebrew/Casks/luma.rb",
    `cask "luma" do
  version "${version}"
  sha256 "${checksums.get(artifact.dmg)}"

  url "${releaseBase}/${artifact.dmg}"
  name "Luma"
  desc "Free open-source terminal and SSH client"
  homepage "${WEBSITE}/"

  depends_on arch: :arm64
  app "Luma.app"

  zap trash: [
    "~/Library/Application Support/dev.bwmp.luma",
    "~/Library/Caches/dev.bwmp.luma",
    "~/Library/Preferences/dev.bwmp.luma.plist",
  ]
end
`,
  ],
  [
    `packaging/winget/manifests/b/BWMP/Luma/${version}/BWMP.Luma.yaml`,
    `# Created for submission to microsoft/winget-pkgs.
PackageIdentifier: BWMP.Luma
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.10.0
`,
  ],
  [
    `packaging/winget/manifests/b/BWMP/Luma/${version}/BWMP.Luma.installer.yaml`,
    `PackageIdentifier: BWMP.Luma
PackageVersion: ${version}
InstallerType: nullsoft
Scope: user
InstallModes:
- interactive
- silent
- silentWithProgress
UpgradeBehavior: install
ReleaseDate: ${(release.published_at ?? release.created_at).slice(0, 10)}
Installers:
- Architecture: x64
  InstallerUrl: ${releaseBase}/${artifact.exe}
  InstallerSha256: ${checksums.get(artifact.exe).toUpperCase()}
ManifestType: installer
ManifestVersion: 1.10.0
`,
  ],
  [
    `packaging/winget/manifests/b/BWMP/Luma/${version}/BWMP.Luma.locale.en-US.yaml`,
    `PackageIdentifier: BWMP.Luma
PackageVersion: ${version}
PackageLocale: en-US
Publisher: BWMP
PublisherUrl: https://github.com/bwmp-dev
PublisherSupportUrl: https://github.com/${REPOSITORY}/issues
PackageName: Luma
PackageUrl: ${WEBSITE}/
License: MIT
LicenseUrl: https://github.com/${REPOSITORY}/blob/${tag}/LICENSE
ShortDescription: Free open-source terminal and SSH client
Description: Luma combines local and serial terminals, saved SSH connections, SFTP, port forwarding, snippets, and optional end-to-end encrypted configuration sync.
Tags:
- ssh
- sftp
- terminal
- serial
- developer-tools
ReleaseNotesUrl: https://github.com/${REPOSITORY}/releases/tag/${tag}
ManifestType: defaultLocale
ManifestVersion: 1.10.0
`,
  ],
  [
    "packaging/snap/snapcraft.yaml",
    `name: luma
title: Luma
base: core24
version: '${version}'
summary: Free open-source terminal and SSH client
description: |
  Luma combines local and serial terminals, saved SSH connections, SFTP,
  port forwarding, snippets, and optional end-to-end encrypted configuration
  sync in one modern application.
grade: stable
confinement: classic
license: MIT
website: ${WEBSITE}
issues: https://github.com/${REPOSITORY}/issues
source-code: https://github.com/${REPOSITORY}
contact: mailto:luma@bwmp.dev
icon: snap/gui/icon.png

platforms:
  amd64:

apps:
  luma:
    command: usr/bin/luma
    desktop: usr/share/applications/Luma.desktop
    extensions: [gnome]

parts:
  luma:
    plugin: dump
    source: ${releaseBase}/${artifact.deb}
    source-type: deb
    source-checksum: sha256/${checksums.get(artifact.deb)}
`,
  ],
  [
    "packaging/flatpak/dev.bwmp.luma.yml",
    `app-id: dev.bwmp.luma
runtime: org.gnome.Platform
runtime-version: '49'
sdk: org.gnome.Sdk
command: luma

finish-args:
  - --share=ipc
  - --share=network
  - --socket=fallback-x11
  - --socket=wayland
  - --device=all
  - --filesystem=host
  - --talk-name=org.freedesktop.secrets

modules:
  - name: luma
    buildsystem: simple
    build-commands:
      - ar x luma.deb
      - tar -xf data.tar.*
      - cp -a usr/bin/luma /app/bin/luma
      - install -Dm644 dev.bwmp.luma.desktop /app/share/applications/dev.bwmp.luma.desktop
      - install -Dm644 dev.bwmp.luma.metainfo.xml /app/share/metainfo/dev.bwmp.luma.metainfo.xml
      - install -Dm644 dev.bwmp.luma.svg /app/share/icons/hicolor/scalable/apps/dev.bwmp.luma.svg
    sources:
      - type: file
        url: ${releaseBase}/${artifact.deb}
        sha256: ${checksums.get(artifact.deb)}
        dest-filename: luma.deb
      - type: file
        path: dev.bwmp.luma.desktop
      - type: file
        path: dev.bwmp.luma.metainfo.xml
      - type: file
        path: dev.bwmp.luma.svg
`,
  ],
]);

for (const [relativePath, contents] of output) {
  const path = resolve(relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  console.log(`updated ${relativePath}`);
}

const metainfoPath = resolve("packaging/flatpak/dev.bwmp.luma.metainfo.xml");
const metainfo = await readFile(metainfoPath, "utf8");
const releaseDate = (release.published_at ?? release.created_at).slice(0, 10);
if (!/<releases>[\s\S]*?<\/releases>/u.test(metainfo)) {
  throw new Error("Flatpak metainfo release entry was not found");
}
const updatedMetainfo = metainfo.replace(
  /<releases>[\s\S]*?<\/releases>/u,
  `<releases>\n    <release version="${version}" date="${releaseDate}" />\n  </releases>`,
);
await writeFile(metainfoPath, updatedMetainfo);
console.log("updated packaging/flatpak/dev.bwmp.luma.metainfo.xml");
