cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "1.5.4"
  sha256 arm:   "dc24724d87bb5d8c2be25d90b9d822db0a65b4dedd85d6315103bbf50709958f",
         intel: "9833f60fc782fb5d46ec9c5974c18727da1576ffbfdcfe8c68155d79470f60e8"

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
