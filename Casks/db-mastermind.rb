cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "1.3.2"
  sha256 arm:   "281c97cb6a868cf675e1faf5c71d8a2c4c2f18cef896564808d0341aaa8e9848",
         intel: "e420740543c9d1ee44b3e7958fb779dc097d7c1c93745b03196223bdcad2eebc"

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
