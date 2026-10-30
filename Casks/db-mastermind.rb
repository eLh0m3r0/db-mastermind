cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "1.0.3"
  sha256 arm:   "c787139ad2657f5ba7fa2044c743accd8f5335cdd9dc36bb4bcf873f455d74f5",
         intel: "2cc9312eb94c157e48d7be8475ac34d248323e7b111b702e6849467f9cff48d7"

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
