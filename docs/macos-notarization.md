# macOS: Developer ID signing and notarization

Prepared 2026-11-21, **switched off** until five repository secrets exist. Without them every release is built
exactly as before: signed by `build/after-pack.cjs` with the project's self-signed certificate (`MAC_SIGN_P12`), not
notarized, and users open it the first time through *System Settings → Privacy & Security → Open Anyway*.

With a Developer ID the app opens like any other downloaded app: no Gatekeeper warning, no `xattr`, and the
Homebrew cask drops its caveat.

Nothing here has run yet. Nobody can test it before the owner has a Developer ID, so the first manual run (section 3)
is the test.

## 1. What happens when the secrets exist

`release.yml` passes these five secrets to the macOS build. When **all five** are set, `build/after-pack.cjs`
signs and notarizes. When some are set and some missing, the build **fails**: it doesn't quietly fall back to the old
signature. When none are set, nothing changes.

| Secret | What it is |
|---|---|
| `MAC_DEVID_P12` | The Developer ID Application certificate with its private key, as a .p12, base64-encoded |
| `MAC_DEVID_PASSWORD` | The .p12's password |
| `APPLE_API_KEY_ID` | The App Store Connect API key's Key ID (like `DEADBEEF42`) |
| `APPLE_API_ISSUER_ID` | The API key's Issuer ID (a UUID) |
| `APPLE_API_KEY_P8` | The API key's private key, the whole `AuthKey_<id>.p8` text |

For each architecture (arm64, x64), after electron-builder has packed the .app and **before** it makes the .dmg and
the .zip, the following steps run with rcodesign 0.29.0 (the version release.yml already pins and checks by SHA-256).
The flags are taken from its source at that tag: `apple-codesign/src/cli/mod.rs` and
`docs/apple_codesign_rcodesign_notarizing.rst`.

1. `rcodesign encode-app-store-connect-api-key --output-path key.json <issuer> <key id> <p8>` builds the API key
   file.
2. `rcodesign sign --for-notarization --p12-file … --p12-password-file … --entitlements-xml-file entitlements.mac.plist
   --entitlements-xml-file "Contents/Frameworks/<helper>.app:entitlements.mac.plist" … "DB Mastermind.app"`
   - `--for-notarization` requires a Developer ID certificate and a timestamp, and turns on the hardened runtime for
     **every** Mach-O. Without it, `--code-signature-flags runtime` would cover only the main executable.
   - rcodesign signs nested code itself, children before their parents. That covers the four helper apps, Electron
     Framework with its helpers and dylibs, Mantle, ReactiveObjC, Squirrel and ShipIt, and the native modules in
     `app.asar.unpacked` (DuckDB's `duckdb.node` and `libduckdb.dylib`, ssh2's `sshcrypto.node`, cpu-features).
   - Entitlements are scoped: rcodesign applies a setting only to the main entity unless the path is named. So the app
     and each `Contents/Frameworks/*.app` helper get `build/entitlements.mac.plist`.
3. `codesign --verify --deep --strict` checks the signature.
4. `rcodesign notary-submit --api-key-file key.json --staple "DB Mastermind.app"` uploads the app (rcodesign zips a
   bundle itself), waits for Apple's verdict and staples the ticket into the app.
5. `xcrun stapler validate` and `spctl --assess --type execute` must both pass, or the build fails.

electron-builder then makes the .dmg and the .zip **from the stapled app**, so:

- **The .zip** used by the app's own updater (`main/mac-update.ts`) and **`latest-mac.yml`'s SHA-512** describe the
  final, stapled files. A .zip can't be stapled itself; the stapled app inside it is what counts.
- **The .dmg** is neither signed nor notarized itself (electron-builder's default). It contains the stapled app,
  which is what Gatekeeper checks when the app is first opened. Signing, notarizing and stapling the .dmg too would
  have to happen after electron-builder has already written its hash into `latest-mac.yml` and the blockmap, so it is
  left out on purpose. Add it later only if the first-launch test shows it's needed.
- **The Homebrew cask** is written with `DBM_NOTARIZED=1`, which leaves out the "not notarized, run xattr" caveat.
- **A manual run from a branch** releases nothing. With the secrets set, it keeps the notarized .dmg, .zip and
  `latest-mac.yml` as the workflow artifact `macos-notarized` for 7 days, so they can be tested.

### Entitlements (`apps/desktop/build/entitlements.mac.plist`)

- `com.apple.security.cs.allow-jit` and `com.apple.security.cs.allow-unsigned-executable-memory`: V8 generates code
  at run time in the main process and in the renderer, GPU and utility helpers. This is the set Electron apps
  commonly use with the hardened runtime.
- **Not** `com.apple.security.cs.disable-library-validation`, although electron-builder's template includes it.
  Library validation lets the app load only libraries signed by the same team or by Apple. Every native module in this
  bundle (listed in step 2 above, checked in a local build on 2026-11-21) is unpacked from the asar and signed by step
  2 with the same Developer ID. msnodesqlv8 (ODBC) and oracledb's binary are not in the macOS bundle. If a library from
  outside the bundle ever has to load (an ODBC driver, a DuckDB extension), add the key then.
- No App Sandbox (the app is distributed outside the Mac App Store), so no network or file entitlements.

### What changes for people who already use the app

- **Saved passwords: no keychain prompt is expected.** The key that encrypts them is created and read by Apple's own
  `/usr/bin/security` tool (`main/storage.ts`, `macSecretKey`), so its keychain access isn't tied to our app's
  signature. CLAUDE.md's warning ("a new certificate triggers that prompt once for every user") dates from the
  safeStorage key; it still applies only to secrets that were never moved to `enc:v2` (they are moved the first time
  they are read). This must be confirmed in step 3.6 below.
- **Privacy permissions** (TCC: access to Documents, Desktop, Downloads, removable volumes) belong to the code
  signature. A different signer may ask once more. This is expected but unverified.
- **Updates keep working across the change.** The app's updater checks the .zip's SHA-512 from `latest-mac.yml`, not
  the signature, and files the app downloads aren't quarantined. A self-signed 1.x updates to a notarized version, and
  back if this is ever rolled back.
- **Homebrew**: the tap's cask points at the same .dmg URL with its new SHA-256; only the caveat goes away.
  Notarization is also what makes a submission to the official homebrew/cask repository possible later; check its
  current rules first.

## 2. The owner's steps, in order

1. **Enrol in the Apple Developer Program** as an individual at https://developer.apple.com/programs/enroll/.
   - Apple's enrolment page says: 99 USD per membership year (local currency at checkout), an Apple Account with
     two-factor authentication, and your legal name.
   - Approval can take a few days.
2. **Create a Developer ID Application certificate.** The Account Holder role is required, and you can have up to
   five.
   - In Keychain Access: *Keychain Access → Certificate Assistant → Request a Certificate From a Certificate
     Authority…*. Enter your e-mail, choose *Saved to disk*.
   - At https://developer.apple.com/account/resources: *Certificates → + → Developer ID → Developer ID Application →
     Continue*. Upload the `.certSigningRequest`, then *Download* the `.cer`.
   - Double-click the `.cer`. It appears in Keychain Access under *My Certificates* as "Developer ID Application: Your
     Name (TEAMID)".
3. **Export it as a .p12 that rcodesign can read.**
   - In Keychain Access, *My Certificates*: select the certificate (with its private key under it) → *File → Export
     Items…* → format *Personal Information Exchange (.p12)* → set a password → save as `keychain-export.p12`.
   - rcodesign can't read the AES-encrypted PKCS#12 that OpenSSL 3 writes by default, which is the same problem as
     with the current certificate. Re-encode it with the legacy algorithms, using Homebrew's OpenSSL 3:

     ```bash
     O=$(brew --prefix openssl@3)/bin/openssl
     $O pkcs12 -in keychain-export.p12 -legacy -nodes -out devid.pem      # asks for the export password
     $O pkcs12 -export -legacy -in devid.pem -out devid.p12               # asks for a new password
     rm devid.pem keychain-export.p12
     ```

   - Keep `devid.p12` and its password in your password manager. It can sign software in your name.
4. **Create an App Store Connect API key** for notarization (Account Holder or Admin).
   - In App Store Connect: *Users and Access → Integrations → App Store Connect API → Team Keys → Generate API Key*.
   - Give it a name ("DB Mastermind notarization") and the *Developer* access role.
   - Download `AuthKey_<KEYID>.p8`. Apple lets you download it only once.
   - Note the **Key ID** (in the key's row) and the **Issuer ID** (above the list).
5. **Store the five secrets** (from the folder with the files, GitHub CLI signed in to the repository):

   ```bash
   base64 -i devid.p12 | gh secret set MAC_DEVID_P12 -R eLh0m3r0/db-mastermind
   gh secret set MAC_DEVID_PASSWORD -R eLh0m3r0/db-mastermind          # paste the .p12 password when asked
   gh secret set APPLE_API_KEY_ID -R eLh0m3r0/db-mastermind --body "<Key ID>"
   gh secret set APPLE_API_ISSUER_ID -R eLh0m3r0/db-mastermind --body "<Issuer ID>"
   gh secret set APPLE_API_KEY_P8 -R eLh0m3r0/db-mastermind < AuthKey_<KEYID>.p8
   ```

   Set all five in one sitting: as soon as one exists, macOS release builds fail until all five do.
6. Tell the maintainer, who runs section 3 **before** the next tag.

## 3. The maintainer's test plan for the first run

1. **Run the release workflow from a branch** (it builds everything and releases nothing):
   `gh workflow run release.yml -R eLh0m3r0/db-mastermind --ref <branch>`, then watch the macOS job.
   - The log shows rcodesign signing each nested item, then `codesign --verify` passing.
   - `notary-submit` prints a submission ID and the status *Accepted*. On *Invalid*, run
     `rcodesign notary-log --api-key-file key.json <id>`: it lists every file Apple rejected and why.
   - `stapler validate` says *The validate action worked!*.
   - `spctl` says *accepted, source=Notarized Developer ID*.
2. **Download the artifact** `macos-notarized`: `gh run download <run id> -n macos-notarized`.
3. **Check the signature** on the app inside the .zip (`ditto -x -k DB-Mastermind-*-mac-arm64.zip .`):
   - `codesign -dv --verbose=4 "DB Mastermind.app"` shows *Authority=Developer ID Application: …*, the TeamIdentifier,
     *flags=0x10000(runtime)* and a *Timestamp*.
   - `codesign -d --entitlements - "DB Mastermind.app"` and the same on
     `"DB Mastermind.app/Contents/Frameworks/DB Mastermind Helper (Renderer).app"` show the two entitlements.
   - `codesign --verify --deep --strict --verbose=2 "DB Mastermind.app"` passes.
   - `spctl -a -vv "DB Mastermind.app"` says *accepted, source=Notarized Developer ID*.
   - `xcrun stapler validate "DB Mastermind.app"` passes.
4. **First launch as a stranger would do it.**
   - Upload the .dmg somewhere and download it with Safari, so it gets the quarantine attribute, on a Mac that has
     never run the app. If possible use a second user account; a Mac without the self-signed certificate's past
     exceptions is better.
   - Open the .dmg, drag the app to Applications and open it. Expected: at most macOS's usual "downloaded from the
     Internet" confirmation, **no** "can't be verified" block and no trip to Privacy & Security.
5. **The app works under the hardened runtime.** These load native code and run JIT under the new rules:
   - `node e2e/smoke.mjs "/Applications/DB Mastermind.app/Contents/MacOS/DB Mastermind"` (SQLite worker, DuckDB native
     binding, MCP mode).
   - `node e2e/ui-smoke.mjs "/Applications/DB Mastermind.app/Contents/MacOS/DB Mastermind" shots` (renderer, demo
     database, a query, the diagram).
   - By hand: an SSH tunnel connection (ssh2's native crypto), a CSV query (DuckDB), and the AI assistant if a
     provider is set up (child processes).
6. **Update from the previous release.**
   - Install the current self-signed release into `~/Applications` and save a connection **with a password**.
   - Serve the run's `latest-mac.yml` and .zip from a local folder: `python3 -m http.server 8000` in the artifact
     folder, with `version:` in `latest-mac.yml` higher than the installed one.
   - Start the old app with `DBM_UPDATE_FEED=http://127.0.0.1:8000`, let it download and restart.
   - Expected: the new version starts, `codesign -dv` on the installed app shows the Developer ID, **no keychain
     prompt** appears, and the saved password still connects.
   - Note any privacy prompt (Documents, Desktop) that comes back: it goes into the release notes.
   - `e2e/mac-update-check.mjs` automates the update itself; `update-check.yml`'s `mac` job runs it against the real
     latest release once one is notarized.
7. **Only then tag the release.** Release notes for that version should say that macOS builds are now notarized. The
   website's install card and the README's macOS paragraph can then drop the *Open Anyway* steps: change them in the
   same release.

## 4. Rollback

- **Before any notarized release is out:** delete the five secrets
  (`gh secret delete MAC_DEVID_P12 -R eLh0m3r0/db-mastermind`, and the same for the other four). The next build is
  self-signed exactly as before.
- **After a notarized release:** the same. The next release is self-signed again; users update to it normally (the
  updater doesn't compare signatures). They see the Gatekeeper first-launch steps again only on a fresh download, and
  the README and website need their *Open Anyway* paragraph back.
- **If Apple revokes or the certificate expires** (see its expiry date in Keychain Access): notarized releases
  already stapled keep opening. Create a new certificate (section 2, steps 2 and 3), replace `MAC_DEVID_P12` and
  `MAC_DEVID_PASSWORD`, and run section 3 again.
- **A leaked .p12 or API key:** revoke the certificate at developer.apple.com and the key in App Store Connect at
  once, then replace the secrets.

## 5. Not verified

- **The whole signing and notarization path.** It has never run. The rcodesign flags were read from rcodesign 0.29.0's
  source and documentation at that tag, not executed.
- **Whether Apple accepts this entitlement set without `disable-library-validation`.** Step 3.5 shows whether every
  native module loads.
- **That an unsigned .dmg holding a stapled app opens without a warning** on current macOS. Step 3.4 shows it.
- **That no keychain prompt appears after the signer changes** (step 3.6), and which privacy permissions macOS asks
  for again.
- **Apple's exact screens and roles.** Section 2's steps were read from Apple's pages on 2026-11-21:
  - https://developer.apple.com/programs/enroll/
  - https://developer.apple.com/help/account/certificates/create-developer-id-certificates/
  - https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/

  They don't say which access role notarization needs (*Developer* is the usual choice), nor where the Key ID and
  Issuer ID are shown.
