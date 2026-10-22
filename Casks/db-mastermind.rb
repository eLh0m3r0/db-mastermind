cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "0.9.2"
  sha256 arm:   "f88f2c29ce8b61ef17c9b9cc7e2d3acedd73413164ecbd9b57bd4671dffb605f",
         intel: "54870370cbdca3a3e6577001f2a7740b84e0292ac435bb1b9da45bea72dbe7db"

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
