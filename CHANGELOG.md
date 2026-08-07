# Changelog

## [0.17.0](https://github.com/bwmp-dev/Luma/compare/v0.16.0...v0.17.0) (2026-08-07)


### Features

* **screenshots:** capture App Store shots from the iOS Simulator ([#22](https://github.com/bwmp-dev/Luma/issues/22)) ([cb7b45a](https://github.com/bwmp-dev/Luma/commit/cb7b45a8ae1d87ae8fa84a93046dc586634f565b))
* **sftp:** implement clipboard functionality for file transfers ([bbbf500](https://github.com/bwmp-dev/Luma/commit/bbbf500b892cb25faddd1cff9697c9e6f8983798))

## [0.16.0](https://github.com/bwmp-dev/Luma/compare/v0.15.0...v0.16.0) (2026-08-02)


### Features

* **privacy:** add PrivacyInfo.xcprivacy file and update privacy disclosures ([484798e](https://github.com/bwmp-dev/Luma/commit/484798e08c0a37112afc35bf144edd37f227623d))

## [0.15.0](https://github.com/bwmp-dev/Luma/compare/v0.14.2...v0.15.0) (2026-08-02)


### Features

* add CI scripts for iOS build process and update project configurations ([7327607](https://github.com/bwmp-dev/Luma/commit/73276077e6058dbf07250f41dd4c2265e9190890))
* add iOS Live Activity support for monitoring SSH connections and file transfers ([0c77a52](https://github.com/bwmp-dev/Luma/commit/0c77a52d02ae5fa967bb2a6da79039f9d06e24bc))
* add server monitoring, resilient sessions, and remote development tooling ([25e8e44](https://github.com/bwmp-dev/Luma/commit/25e8e44d0d73ceef3b3de453d711dd67922fcbe1))
* add server monitoring, resilient sessions, and remote development tooling ([25e8e44](https://github.com/bwmp-dev/Luma/commit/25e8e44d0d73ceef3b3de453d711dd67922fcbe1))
* **analytics:** add consent-gated anonymous product analytics ([0f94f03](https://github.com/bwmp-dev/Luma/commit/0f94f03714d93cb7f9c6d8c6874b11b0d9cd8520))
* **appearance:** integrate system appearance handling into mobile components and update related styles ([5520992](https://github.com/bwmp-dev/Luma/commit/5520992cfae94a04d187b8be83539870d91a0a36))
* **desktop:** add external links for website, GitHub, issues, and Discord in settings ([f630f80](https://github.com/bwmp-dev/Luma/commit/f630f80ff77a0684959d545d6c3d812bd0b0d230))
* enhance agent inbox with heuristic event detection ([e35575f](https://github.com/bwmp-dev/Luma/commit/e35575f1439ab60935ce6767cad57a082cbe43d3))
* enhance mobile terminal experience with keyboard assistant and accessory bar ([93bb639](https://github.com/bwmp-dev/Luma/commit/93bb639a23a7ddd5bf2b4d42a8af6e94bc912dde))
* enhance version extraction logic in ci_pre_xcodebuild.sh for better build consistency ([e0b7bec](https://github.com/bwmp-dev/Luma/commit/e0b7bec6bee70b009eed557f24983acbf4fd1055))
* implement context menus for mobile sessions and SFTP entries, enhance user selection behavior ([f46fe09](https://github.com/bwmp-dev/Luma/commit/f46fe0925388c549cf17b2ab7df9d3567f07a018))
* improve keyboard accessory handling for first responders in LumaKeyboardAssistant ([00ebb56](https://github.com/bwmp-dev/Luma/commit/00ebb561b51e668891e704349de1960fc03ddb4d))
* **mobile:** add external links for Discord, GitHub, and website in mobile UI ([d104092](https://github.com/bwmp-dev/Luma/commit/d1040928395fc9ccddf449755f6f3616dc9121f0))
* **mobile:** add grouped mobile host editor ([2247a76](https://github.com/bwmp-dev/Luma/commit/2247a768c04f8415711a76e216f6d8b4dc933612))
* **mobile:** add live session previews and related settings in mobile UI ([4653120](https://github.com/bwmp-dev/Luma/commit/46531203f699ec2227bbe72ed1796ac3b991b978))
* **mobile:** add touch gesture settings for arrow keys and Tab in terminal ([3fc03b6](https://github.com/bwmp-dev/Luma/commit/3fc03b6c169368d9cf9588692ca0858b68de7169))
* **mobile:** bring server monitoring and the agent inbox to the mobile shell ([0fa35ab](https://github.com/bwmp-dev/Luma/commit/0fa35abc045187ab3a01696adb2a4fbf61ae60ae))
* **mobile:** implement shared-terminal collaboration and enhance mobile UI components ([6b3f222](https://github.com/bwmp-dev/Luma/commit/6b3f222877079271eed8c7b6fd0c6966529f099e))
* **permissions:** add vault management commands to existing and mobile command permissions ([e551471](https://github.com/bwmp-dev/Luma/commit/e551471ac2bcd5711f7cae6f2f070639fd3c3307))
* **port-forwarding:** enable port forwarding and add mobile command permissions for tunnels ([be57e8d](https://github.com/bwmp-dev/Luma/commit/be57e8d5421ae0d4b03e355a096855b98a6c750f))
* **server-stats:** add an agentless server dashboard over SSH ([25e8e44](https://github.com/bwmp-dev/Luma/commit/25e8e44d0d73ceef3b3de453d711dd67922fcbe1))
* **sftp:** copy files directly between two connected hosts ([d102513](https://github.com/bwmp-dev/Luma/commit/d10251362f585ab77da48a08b21b8a5317ab1fc8))
* **sync:** implement vault key sealing and management ([d87690d](https://github.com/bwmp-dev/Luma/commit/d87690d6810827dde856fbfc06406d8c38e70787))
* **tab-bar:** add ios-glass-tabbar plugin with permissions and initial setup ([e92daf7](https://github.com/bwmp-dev/Luma/commit/e92daf7096670f46488379e925f21a4de7304923))
* **tab-bar:** add tab bar lab command and enhance diagnostics in mobile settings ([549230e](https://github.com/bwmp-dev/Luma/commit/549230e29a1efcfe83ca053b3ab4b47d88552b51))
* unify mobile terminal rendering and font setup ([5c6350d](https://github.com/bwmp-dev/Luma/commit/5c6350de93d097fccfb22687ea5043b841f3f643))
* update .gitignore and ci_build_rust.sh for asset management and build process ([9b729fe](https://github.com/bwmp-dev/Luma/commit/9b729feeb4fcff218db0906d2738a204e97d6112))
* update ExportOptions.plist to use app-store-connect method ([3c1210a](https://github.com/bwmp-dev/Luma/commit/3c1210ab913a47b40b01f19cb6da9d69b411f14c))
* **vaults:** enhance VaultRow to support sharing functionality and improve sync configuration handling ([625df9c](https://github.com/bwmp-dev/Luma/commit/625df9c8d934fcba06951e0bf9cd34cf47301b70))
* **vaults:** refactor mobile settings to integrate vault management and update navigation ([bd30451](https://github.com/bwmp-dev/Luma/commit/bd30451e11056ff30e06346d0b408f8deb223644))
* **website:** add Discord support links to Footer and Support components ([718cfa5](https://github.com/bwmp-dev/Luma/commit/718cfa56bb139de4378ff8f3269ba2427de7ef01))


### Bug Fixes

* add ITSAppUsesNonExemptEncryption key to Info.plist and project.yml ([70d2ff3](https://github.com/bwmp-dev/Luma/commit/70d2ff37d0787ae128ff9b87b0e77b57dcbb945e))
* build Tauri Rust library in Xcode Cloud ([ba71c06](https://github.com/bwmp-dev/Luma/commit/ba71c0629189e01bdf548e881d83a5f19250e2b3))
* improve rustup installation process with error handling and cleanup ([42bf952](https://github.com/bwmp-dev/Luma/commit/42bf95231d455ff1182c3b06cc85d406d8a1f925))
* ios? ([93ef5a5](https://github.com/bwmp-dev/Luma/commit/93ef5a50327838bccaa61848acfac99db1c5b167))
* **macOS:** bundle Icon Composer assets for app icons ([272fcfd](https://github.com/bwmp-dev/Luma/commit/272fcfdbb0643daaf4080cb35e3da62e2fb2a467))
* stage frontend assets for Xcode Cloud ([db4f193](https://github.com/bwmp-dev/Luma/commit/db4f193dd15a391a81ced4be9ad5317e8d063caa))
* update cargo build arguments for custom protocol and correct release endpoint URL ([03dc46f](https://github.com/bwmp-dev/Luma/commit/03dc46fe780efdd05ea9daff1639bf8f977a237d))
* update iOS build settings and improve project configuration ([acc8286](https://github.com/bwmp-dev/Luma/commit/acc8286ee22a8fea50aa5ca519b65ec843e60878))
* vault switcher dropdown not working ([8fdcb2f](https://github.com/bwmp-dev/Luma/commit/8fdcb2f37d030bb9cd32fd5dddb61d73d3012396))

## [0.14.2](https://github.com/bwmp-dev/Luma/compare/v0.14.1...v0.14.2) (2026-07-25)


### Bug Fixes

* z-index values for broadcast and logging indicators in PaneView component ([67492de](https://github.com/bwmp-dev/Luma/commit/67492deb96f42a6ca253aac5ae383f5a180bcfcd))

## [0.14.1](https://github.com/bwmp-dev/Luma/compare/v0.14.0...v0.14.1) (2026-07-25)


### Bug Fixes

* correct path for SQL migration files in .gitattributes ([d54cb33](https://github.com/bwmp-dev/Luma/commit/d54cb332d638d3474c949f33896e3daca57bc98a))
* update beforeBuildCommand to include shared build step ([3ca311e](https://github.com/bwmp-dev/Luma/commit/3ca311e908dc60ab1dcfd30a85813fd74d69133e))

## [0.14.0](https://github.com/bwmp-dev/Luma/compare/v0.13.0...v0.14.0) (2026-07-25)


### Features

* add script to compile Apple icon and update destination path ([b66a1c2](https://github.com/bwmp-dev/Luma/commit/b66a1c2ada87d898b731acc2de68552ec35c518c))

## [0.13.0](https://github.com/bwmp-dev/Luma/compare/v0.12.0...v0.13.0) (2026-07-25)


### Features

* add encrypted multi-instance collaboration infrastructure ([eb201b1](https://github.com/bwmp-dev/Luma/commit/eb201b14b5dad1918f1d7814815f58e7c197d9b2))
* add Luma theme for Keycloak login ([2423511](https://github.com/bwmp-dev/Luma/commit/2423511d53cd69d7ea7aaa5404bf6739bb486305))
* **collaboration:** implement collaboration features including device identity management, room invites, and capability handling ([d5ac989](https://github.com/bwmp-dev/Luma/commit/d5ac989a239f45bb91ceb70ed190606fd9f16148))
* enhance collaboration store to manage multiple runtimes ([580482c](https://github.com/bwmp-dev/Luma/commit/580482c6518b25fa85a513bf5e25b2d686cc5ea5))
* enhance tab drag functionality ([580482c](https://github.com/bwmp-dev/Luma/commit/580482c6518b25fa85a513bf5e25b2d686cc5ea5))
* implement pane movement and detachment functionality ([580482c](https://github.com/bwmp-dev/Luma/commit/580482c6518b25fa85a513bf5e25b2d686cc5ea5))
* improve UI store for new tab handling ([580482c](https://github.com/bwmp-dev/Luma/commit/580482c6518b25fa85a513bf5e25b2d686cc5ea5))
* remove iCloud Drive support and update sync provider options ([5d3005b](https://github.com/bwmp-dev/Luma/commit/5d3005b325f706b0868ed103a0edef0052cb255b))


### Bug Fixes

* update website metadata for better SEO ([580482c](https://github.com/bwmp-dev/Luma/commit/580482c6518b25fa85a513bf5e25b2d686cc5ea5))

## [0.12.0](https://github.com/bwmp-dev/Luma/compare/v0.11.0...v0.12.0) (2026-07-24)


### Features

* add mobile screenshot capture and enhance terminal content for narrow viewports ([b95de4d](https://github.com/bwmp-dev/Luma/commit/b95de4d7f1198b27bc3e95952fb4e3be74a24d00))
* add notarization and staple process for macOS DMG in release workflow ([1bd8c4f](https://github.com/bwmp-dev/Luma/commit/1bd8c4fdd7a96ddfffe16775b6e755dce6d5fdff))

## [0.11.0](https://github.com/bwmp-dev/Luma/compare/v0.10.0...v0.11.0) (2026-07-24)


### Features

* add iCloud Drive support for synchronization and update related configurations ([32ae1b6](https://github.com/bwmp-dev/Luma/commit/32ae1b6ecf17ea458a1bd09ea32b1d893b22bc5f))
* **branding:** add Icon Composer assets for Liquid Glass app icon ([717cdf1](https://github.com/bwmp-dev/Luma/commit/717cdf190d7562f9d66612814626a885333f612f))
* implement iCloud Drive support and update related configurations ([bd36a0b](https://github.com/bwmp-dev/Luma/commit/bd36a0bd659443470b3b00747ac157e6bec8aa7f))

## [0.10.0](https://github.com/bwmp-dev/Luma/compare/v0.9.0...v0.10.0) (2026-07-23)


### Features

* add iPad screenshot capture script ([4ae18b6](https://github.com/bwmp-dev/Luma/commit/4ae18b622e85db463185be206e6a97a574cae7ee))
* add macOS signing and notarization steps to release workflow ([8505edf](https://github.com/bwmp-dev/Luma/commit/8505edfc23eb8d93d6ebb1bfa3a38a169b6dbe1d))

## [0.9.0](https://github.com/bwmp-dev/Luma/compare/v0.8.0...v0.9.0) (2026-07-22)


### Features

* enhance mobile support and add troubleshooting page ([437f0c3](https://github.com/bwmp-dev/Luma/commit/437f0c351f0dd733997bba4ff13b4e11c6d00c36))
* update iOS version to 0.8.0 and improve shell script for build process ([5db7209](https://github.com/bwmp-dev/Luma/commit/5db7209c56948c55e7bffc3a2715332df28acf1c))
* update luma version to 0.8.0 and conditionally include modules for non-iOS/Android platforms ([94c6515](https://github.com/bwmp-dev/Luma/commit/94c651539326ebd823f07c909b7ce4a6549870b2))
* **website:** initial commit ([9fbfa7e](https://github.com/bwmp-dev/Luma/commit/9fbfa7e1654160af7127c1c9e1b1e1985f4c56bb))

## [0.8.0](https://github.com/bwmp-dev/Luma/compare/v0.7.0...v0.8.0) (2026-07-21)


### Features

* add identity management features including syncing and UI updates ([b6cb523](https://github.com/bwmp-dev/Luma/commit/b6cb523e862e68f6c798cd1cdb105cb3659b1851))
* add iOS support and update project configuration for Luma ([9fc0924](https://github.com/bwmp-dev/Luma/commit/9fc09247c27fbe2979fd5c0b7c89b55f6bb2cd32))
* MOBILE SUPPORT???? ([967868e](https://github.com/bwmp-dev/Luma/commit/967868e263a8490fcc8e092aab1b0fa4efaa3596))
* update luma version to 0.7.0 in Cargo.lock and Cargo.toml ([8732992](https://github.com/bwmp-dev/Luma/commit/8732992e110113c41fe4fbf1fa5fbb8daa808c8c))

## [0.7.0](https://github.com/bwmp-dev/Luma/compare/v0.6.0...v0.7.0) (2026-07-19)


### Features

* add 12 terminal, SSH, and SFTP productivity features ([32ed9a1](https://github.com/bwmp-dev/Luma/commit/32ed9a11a6216cdeacfee3a48b892a29f5901643))
* update luma version to 0.6.0 in Cargo.lock and Cargo.toml ([706f853](https://github.com/bwmp-dev/Luma/commit/706f853bd8064b635e8657ca864442e1d282081c))

## [0.6.0](https://github.com/bwmp-dev/Luma/compare/v0.5.0...v0.6.0) (2026-07-18)


### Features

* update version to 0.5.0 and enhance close handling in session management ([2bde6fe](https://github.com/bwmp-dev/Luma/commit/2bde6fe72827c85b43d6bd8c7bc875ab00c46b66))

## [0.5.0](https://github.com/bwmp-dev/Luma/compare/v0.4.0...v0.5.0) (2026-07-18)


### Features

* add audit.toml for advisory management and .gitattributes for SQLx migration stability ([52e85d6](https://github.com/bwmp-dev/Luma/commit/52e85d6dcd6fbe520c22b34d480be6ba85176bae))
* add terminalManager tests for spawn races and session handling ([9b7a88d](https://github.com/bwmp-dev/Luma/commit/9b7a88d7a1f08755e4b0e88c3b4ca9b3fec5195a))
* enhance session management with new features and improve error handling ([9ec74ef](https://github.com/bwmp-dev/Luma/commit/9ec74effbacff2fe8fe8139fe014a7c81ed74041))
* Implement embedded SSH backend and enhance askpass functionality ([7293d71](https://github.com/bwmp-dev/Luma/commit/7293d71a6cf3f7f4062f7fe8e3588def49d5173e))
* implement waitFor function to enhance polling mechanism in session tests ([c89a14b](https://github.com/bwmp-dev/Luma/commit/c89a14bdbdd3cb664015b61254f8854e07ff15cc))

## [0.4.0](https://github.com/bwmp-dev/Luma/compare/v0.3.0...v0.4.0) (2026-07-17)


### Features

* implement migration recovery to handle checksum drift without data loss ([3554865](https://github.com/bwmp-dev/Luma/commit/35548659dcebafb9713319d145b4dfa933403e0c))

## [0.3.0](https://github.com/bwmp-dev/Luma/compare/v0.2.0...v0.3.0) (2026-07-17)


### Features

* update .gitignore to exclude Tauri configuration files ([e6206a0](https://github.com/bwmp-dev/Luma/commit/e6206a0c137031f8b316de2f4ef9a24e65dbb410))

## [0.2.0](https://github.com/bwmp-dev/Luma/compare/v0.1.0...v0.2.0) (2026-07-17)


### Features

* add conditional compilation for find_in_path function on Windows ([0071a76](https://github.com/bwmp-dev/Luma/commit/0071a76dc6dfbd6c52ddbe3891e48de1079df123))
* add passphrase handling for SSH keys and derive public key functionality ([aa7d208](https://github.com/bwmp-dev/Luma/commit/aa7d20894e65d2644acc5f54a7e00cfe11caf216))
* add SFTP support and SSH enhancements ([3088d97](https://github.com/bwmp-dev/Luma/commit/3088d97540b6faf9e386d02a672dd090688a4aa5))
* implement hooks and state management for hosts, port forwards, snippets, and sync functionality ([7c039ee](https://github.com/bwmp-dev/Luma/commit/7c039eea2d9c4823be26dce445942d54927f1a5d))
* implement Release Please configuration and workflow for automated releases ([4141fa2](https://github.com/bwmp-dev/Luma/commit/4141fa22ef77a013dcf3a3a97a945dcb35e04c71))
* implement workspace snapshot persistence and updater features ([8218b2c](https://github.com/bwmp-dev/Luma/commit/8218b2cb723b3cd0a67cefe981bbb43773e3ebc9))
* update Tauri build configuration to use external config file ([550fe68](https://github.com/bwmp-dev/Luma/commit/550fe687c8a32d07147467d9bd8f431037f9e820))
