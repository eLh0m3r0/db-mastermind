cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "0.9.12"
  sha256 arm:   "553716ba6f25f7f5f9d1541c8c5d574e1a9a4ccfd1657f4e570662a8e94360b5",
         intel: "dfb75226e0c7dadeb5432630d438eabeac6dd3cf41642898622f2e1a0a31e96a"

  url "https://github.com/eLh0m3r0/db-mastermind/releases/download/v#{version}/DB-Mastermind-#{version}-mac-#{arch}.dmg"
  name "DB Mastermind"
  desc "Database client with ER diagrams, schema design with migrations and AI"
  homepage "https://elh0m3r0.github.io/db-mastermind/"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on :macos

  app "DB Mastermind.app"

  zap trash: [
    "~/Library/Application Support/DB Mastermind",
    "~/Library/Preferences/dev.dbmastermind.app.plist",
  ]

  caveats <<~EOS
    DB Mastermind is not notarized yet. If macOS refuses to open it, run:
      xattr -dr com.apple.quarantine "/Applications/DB Mastermind.app"
  EOS
end
