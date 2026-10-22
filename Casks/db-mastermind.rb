cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "0.9.7"
  sha256 arm:   "569364b7c4ad2491a887a63a42a2e2697c83c4e83a38b943f1526ba445e8b464",
         intel: "2a1ef01a7f84c5678f0d487152988d5b4640180a671336a7f6bb69071e718d0f"

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
