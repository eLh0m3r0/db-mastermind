cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "0.9.11"
  sha256 arm:   "8337bd8d3cf151b66e58fe5bc4ee21e2b5c66cf4fa1c4f61213a80039165fd39",
         intel: "52ffaddf8b0924a628bbb2ed6e391c3a6ec45280967e0139c7d03c4c66d1f2fa"

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
