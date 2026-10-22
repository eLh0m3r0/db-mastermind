cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "0.9.17"
  sha256 arm:   "c8d36bd8bc9ed818b75f0e7bd563e673895825bc5f167cf09d04c0f7fa900895",
         intel: "cca6fd09c19edea25313e040f3bdb21cbae536757ca63852aac8145a171ae91e"

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
