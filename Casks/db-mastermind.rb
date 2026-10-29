cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "1.0.1"
  sha256 arm:   "e601b77103e8d2f63a4f3a08f9f346d0430a40450704094c1f1a5bf3a158f67d",
         intel: "99d4577bb132757bd255548be851bd7e00be11af0a1e4f6b042c4858d7d9a396"

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
