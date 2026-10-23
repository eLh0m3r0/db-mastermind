cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "0.9.21"
  sha256 arm:   "7e88dd9c91f2071362d3a41fcb89cf012f2dd9577f416fc63af34d56c979240c",
         intel: "5d6deb736b257b1441d596ed19422fb0ecef91fb6d3c59a0fd7e0cc68afbb8ff"

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
