cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "1.1.0"
  sha256 arm:   "1959f71e6424097247af93d28d8ad940ca5b680c2271bc6a9af48ce3bd195b42",
         intel: "33915c6288735f4b68c004b5db94f1967ae43b37cd1f34a0244bd555eee32754"

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
