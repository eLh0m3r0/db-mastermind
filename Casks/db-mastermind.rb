cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "1.2.0"
  sha256 arm:   "b4e53c114ed15091b7adb9a5c475d3aa2bf5d23d4e1e469f3764913bce985cfc",
         intel: "14a17c12c871af023b279162163a506965c102773f1147e172c7b0b53023e08a"

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
