cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "0.9.4"
  sha256 arm:   "8a61cdf2bb1fb7b925ac8d6d195a7b7e8382a12e8d27e27a3be7622777914bb7",
         intel: "fe5851ee5553a345fe8fef258e08efc46466d25866b524148537e304976e6631"

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
