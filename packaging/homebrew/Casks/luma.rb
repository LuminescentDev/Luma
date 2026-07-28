cask "luma" do
  version "0.14.2"
  sha256 "2480e194ad12879c697720f60624d026f886d221dafa72f263c7af86ce68ebcb"

  url "https://github.com/bwmp-dev/Luma/releases/download/v0.14.2/Luma_0.14.2_aarch64.dmg"
  name "Luma"
  desc "Free open-source terminal and SSH client"
  homepage "https://luma.bwmp.dev/"

  depends_on arch: :arm64
  app "Luma.app"

  zap trash: [
    "~/Library/Application Support/dev.bwmp.luma",
    "~/Library/Caches/dev.bwmp.luma",
    "~/Library/Preferences/dev.bwmp.luma.plist",
  ]
end
