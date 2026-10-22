# Publishing to the Microsoft Store

The Store signs the app (no SmartScreen warnings) and keeps it updated. Registration for individuals is free.

## One-time setup (the account owner)

1. Create a developer account at [storedeveloper.microsoft.com](https://storedeveloper.microsoft.com). Individual
   accounts are free; identity is verified with an ID and a selfie.
2. In [Partner Center](https://partner.microsoft.com/dashboard/apps-and-games/overview): **Apps and games → New
   product → MSIX or PWA app**, reserve the name **DB Mastermind**.
3. Open the product → **Product management → Product identity** and copy the three values into the repository's
   **Settings → Secrets and variables → Actions → Variables**:

   | Partner Center | Repository variable |
   |---|---|
   | Package/Identity/Name | `MSSTORE_IDENTITY_NAME` |
   | Package/Identity/Publisher (`CN=…`) | `MSSTORE_PUBLISHER` |
   | Package/Properties/PublisherDisplayName | `MSSTORE_PUBLISHER_NAME` |

From the next release on, `DB-Mastermind-<version>-store.appx` is attached to the GitHub release.

## Each submission

1. Partner Center → the product → **Start your submission**.
2. **Packages**: upload `DB-Mastermind-<version>-store.appx` from the GitHub release.
3. First time only:
   - **Pricing**: Free.
   - **Properties**: category *Developer tools*. For the restricted capability `runFullTrust`, explain that it's a
     desktop database client that connects to databases over the network and works with local files.
   - **Store listings**: description and screenshots, reusing the README text and `docs/screenshots/`.
   - **Age ratings**: the questionnaire.
4. **Submit to the Store**. Certification usually takes a few days. Store installs update through the Store; the
   app's own updater is off for them.

Submissions can later be automated from GitHub Actions with the Microsoft Store CLI (`msstore`), using an Entra ID
app registration's credentials as repository secrets.
