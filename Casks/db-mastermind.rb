cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "1.4.0"
  sha256 arm:   "e0fc0ac1f364073af8ae7180c45ff3d6cdf92a07cb7eeceed887d5206a9db8d3",
         intel: "f26f2b1a734d154c8d59f73a3087be6c8522d26baedfa5c7481fba9b84919f03"

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
