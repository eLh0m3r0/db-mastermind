cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "1.0.2"
  sha256 arm:   "6dce1990f1228b2f4a34bd5a1d35e35a23efb1ec49e6b5f822cffef180208b4b",
         intel: "4e3b6dbdea210cded04ed187637a1c7f6b1d62b9169896beeeeb61f26a8f88fd"

  url "https://github.com/eLh0m3r0/db-mastermind/releases/download/v#{version}/DB-Mastermind-#{version}-mac-#{arch}.dmg"
  name "DB Mastermind"
  desc "Database client with ER diagrams, schema design with migrations and AI"
  homepage "https://dbmastermind.app/"

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
