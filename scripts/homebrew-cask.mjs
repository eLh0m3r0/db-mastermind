// Homebrew cask kept in this repository (it doubles as a tap):
//   brew tap elh0m3r0/db-mastermind https://github.com/eLh0m3r0/db-mastermind
//   brew install --cask db-mastermind
// Usage: node scripts/homebrew-cask.mjs <version> <arm64 dmg> <x64 dmg> > Casks/db-mastermind.rb
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const [version, arm64, x64] = process.argv.slice(2)
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

process.stdout.write(`cask "db-mastermind" do
  arch arm: "arm64", intel: "x64"

  version "${version}"
  sha256 arm:   "${sha(arm64)}",
         intel: "${sha(x64)}"

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
`)
