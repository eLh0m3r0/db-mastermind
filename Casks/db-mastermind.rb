cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "1.0.0"
  sha256 arm:   "ab8650b20b781539c7a3b4ef2bbe4eeb00a86a3a906e5dc6212db1d9570466f2",
         intel: "920fd261d0b7de4a6ccde2104f197ee437a2d2d3893839262cb4b95549bdae27"

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
