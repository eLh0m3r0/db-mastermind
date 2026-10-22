cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "0.9.1"
  sha256 arm:   "d6701d77f6292816ca65187a07b91bbe02c554be5c1e5efb5677e4d9b7f1cda2",
         intel: "350089ab4117545bbf2f2ccb85a15b6c872298742edd008ed7c74d1077c65c8b"

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
