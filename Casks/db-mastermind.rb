cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "0.9.8"
  sha256 arm:   "a6aa655fa8234c0a5ba3936c8e5a9e6131d11e0e6260f08753f5a723f49eeffc",
         intel: "1ec8d29a2404e27733e869fa882ce43d45544a639486a208520deb164e87b35a"

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
