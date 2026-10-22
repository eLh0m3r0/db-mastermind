cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "0.9.14"
  sha256 arm:   "714d9f4b21a9c34dfe7b1e6d068d4d54b513a3132f66e89785c1f369581cdf12",
         intel: "25987bfa3e62d4f0afbc644a5e30ef79f7f24fb11f5c67217d5065742ea41a64"

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
