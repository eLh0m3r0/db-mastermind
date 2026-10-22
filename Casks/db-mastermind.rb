cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "0.9.3"
  sha256 arm:   "9f37021394f6c97e80d053f115e5f55c18c16a926255f34e73cc34056c86caef",
         intel: "b26226fa6a69fa28f2311d22e0fb8d8ddf94c728d55eb4ee54d89d26947660a5"

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
