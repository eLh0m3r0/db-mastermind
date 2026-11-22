cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "1.5.3"
  sha256 arm:   "f834223be6db6b9a386ec07a19d0402fe905ace91e1656259a51c4d4e88cb777",
         intel: "e2d846f6a47f928435d1810e8e39aa4878e382207972381c558a6ae5bdb43e9e"

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
