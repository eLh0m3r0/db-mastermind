cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "0.8.0"
  sha256 arm:   "6cebfc0de441bf861baee9b1331758de93be58852498078d290bdd1697a6e95a",
         intel: "50ec61a72a4ee4169c49e8b40efba970963c91ea4e988bda8571ff8056f11277"

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
