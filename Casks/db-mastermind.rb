cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "0.9.5"
  sha256 arm:   "fea42bcc6ac9661c67dd9061387362b6a44eb4c3690da13a167ce850904780f7",
         intel: "f52260457c8adad1e76e8673be24e7de0fc82097e0e30e628ede09177ae233d2"

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
