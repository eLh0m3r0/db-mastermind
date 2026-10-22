cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "0.9.9"
  sha256 arm:   "93a97ce4fbc8bb70961897f5df0a2444f91f12169144cab68c46cf59e84de14b",
         intel: "a8291c4d4296735d5d4a17c27ba79867e8b23b1ec1a25932b56ba57d1ef4606c"

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
