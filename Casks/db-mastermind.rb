cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "0.9.16"
  sha256 arm:   "c9127badf3f1fa157d5f6a883437e65538782f6bd2b75f110b533a10a99e3a72",
         intel: "edbf8ef4bb2826cdce8271b268ceef73be8e4b8ff92ee58d9113ff7293147ecb"

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
