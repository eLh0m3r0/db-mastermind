cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "0.9.19"
  sha256 arm:   "626498ae529ab9d80e45fff0e971997b794c7c83da16f73f786fbd3e2442de45",
         intel: "fa0dec0017b4a4e295f125dc2f217de38eee58ee3dd7ea22e96074547c1ec9db"

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
