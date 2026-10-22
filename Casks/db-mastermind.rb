cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "0.9.0"
  sha256 arm:   "da65d867937f6bbff7cb845e698c1d2e8ced8666e94d02d196cdf39d6550c6aa",
         intel: "e5d0fba7b20c7504a504ceff8e79397d91147a82e2086371932680b53c3cc605"

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
