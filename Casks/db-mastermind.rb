cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "0.9.6"
  sha256 arm:   "fcef1ac6edfc8b694c3d9ebc996b381e5b920c07ba55437be9f077731eb9afec",
         intel: "21465e6d834218512b630e34f9568f7872e257ff6bdf747367c0a8443afbdf32"

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
