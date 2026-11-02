cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "1.0.4"
  sha256 arm:   "62374965bfe24c7d6580a2f7c5f03e09d9e16b51c9db4119adb583ffe8a5865f",
         intel: "ad7f108f24e4a66c251124b2e90225ed12271726e93c7f3ba32ed0ca8fbce60a"

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
