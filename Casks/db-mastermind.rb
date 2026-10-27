cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "0.9.22"
  sha256 arm:   "be32f26fef84cdefce2da453d49cc1d64c98b7363afb9268d7cf02cc1dea07e0",
         intel: "48c6ac76c1c180251bfbc10af1f3052395f8f646dcba118c9808930f83037e7d"

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
