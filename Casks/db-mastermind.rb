cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "1.3.1"
  sha256 arm:   "616d12e2dab138d234f53bca1b43963ec3b654f439bfe44c76e3b51eca872603",
         intel: "bc361580e27f29c9d63408224c45ae5a9e60f0adabc39ad35d22912d1eabd2f7"

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
