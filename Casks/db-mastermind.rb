cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "1.3.0"
  sha256 arm:   "96014910022686007eb801a0d7c5f5499f351e8094e693a4bd8b2f2025a06878",
         intel: "1a97a0fc5381691d4e886eee0dc38301fffba760c617148d2526f05a5361fe5b"

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
