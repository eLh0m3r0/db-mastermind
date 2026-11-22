cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "1.5.0"
  sha256 arm:   "5dba3d8a17e7689d6d990cd6e682c8418ca0c48da3e32bc75ac0d2fc2464de93",
         intel: "63df77003748d230218181b2062d3e1478c0f2b67ff7aadf21b9e69cfbed786e"

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
