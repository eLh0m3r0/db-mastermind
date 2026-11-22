cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "1.5.1"
  sha256 arm:   "4f21c075f8247244f66d8cafcee2d69e0aee5ca6d15ec21deebdda51ab83d6c8",
         intel: "43a1283f043eab5383062848d66ecb10daa7b9e3ece275c63c71cbdfee2a19ad"

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
