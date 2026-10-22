cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "0.7.0"
  sha256 arm:   "f27fef1cbf7765c2fb3afeaa551c0a1332e9c8d1b29bcf57967f3a50c7368084",
         intel: "0bd2d3fd6836903dca36f611f24657c51048b8d5bba5752f914f7d636cd0f3e0"

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
