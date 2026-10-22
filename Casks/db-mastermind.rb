cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "0.9.18"
  sha256 arm:   "2ead2628a69428f948ee9863ebc487a8dc29413515190f2052ce0cfff388e516",
         intel: "a0e7a353562f2d97fc9c9612eb319c107d21f4b63e5a9b018ac913b22dbb788a"

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
