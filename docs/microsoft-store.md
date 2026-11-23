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
   - **Store listings**: texts in English and Czech, screenshots and captions: see [store-listing.md](store-listing.md).
   - **Age ratings**: the questionnaire.
4. **Submit to the Store**. Certification usually takes a few days. Store installs update through the Store; the
   app's own updater is off for them.

## Submitting from GitHub

After testing a release, one workflow sends it to the Store: first see what would change, then send it.

```bash
gh workflow run store-submit.yml -f tag=v1.5.4 -f mode=plan     # prints the changes; sends nothing
gh workflow run store-submit.yml -f tag=v1.5.4 -f mode=submit   # creates, uploads and commits the submission
```

The plan lists, per language, each text (changed or not, with its length), the features added and removed, the
screenshots before and after with their captions, and the package version before and after. Every Store limit is
checked before anything is sent.

- **From the repository** (at the tag; `-f listing=main` when the texts were finished after tagging): short
  description, description, product features, search terms, What's new, copyright, and the screenshots with their
  captions, all from [store-listing.md](store-listing.md) and `docs/screenshots/`. The package is the release's
  `DB-Mastermind-<version>-store.appx`; its identity must match `MSSTORE_IDENTITY_NAME` and `MSSTORE_PUBLISHER`.
- **Kept from Partner Center** (as the last published submission has it): the product name, privacy policy, website,
  support contact, additional license terms, Developed by, logos and trailers, hardware, pricing and availability,
  properties and age ratings. Change those in Partner Center.
- **Refused**: while another submission is in progress in Partner Center (finish or delete it there). If anything
  fails before the commit, the workflow deletes the draft it made.

Secrets (**Settings → Secrets and variables → Actions → Secrets**), from an app registration in Microsoft Entra ID
that has the **Manager** role in Partner Center (**Account settings → User management → Microsoft Entra
applications**):

| Secret | Where it comes from |
|---|---|
| `MSSTORE_TENANT_ID` | Entra ID → the app registration → Directory (tenant) ID |
| `MSSTORE_CLIENT_ID` | the app registration's Application (client) ID |
| `MSSTORE_CLIENT_SECRET` | the app registration → Certificates & secrets → a client secret (renew before it expires) |
| `MSSTORE_SELLER_ID` | Partner Center → Account settings → Legal info → Seller ID |

