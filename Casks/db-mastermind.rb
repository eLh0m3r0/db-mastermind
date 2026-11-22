cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "1.5.2"
  sha256 arm:   "55cfb4616dda5bcb04a8834b37b76062b40cd352796f5fa6a54fc240ebf6f6a4",
         intel: "339e345d1cd92800be228fd3dccfb30c1d65230dc562bc43f696415901f017e5"

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
