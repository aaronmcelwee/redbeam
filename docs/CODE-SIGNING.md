# Code signing (Authenticode)

Windows decides whether to run a downloaded `.exe` partly on who signed it.
An unsigned REDBEAM installer gets SmartScreen's "Windows protected your PC",
and on a PC with Smart App Control or an organisation's app-control policy
(AppLocker, WDAC, Intune) it can be refused outright with "Windows cannot
access the specified device, path, or file. You may not have the appropriate
permissions". Signing gives the file a verifiable publisher.

This is separate from the updater's minisign `.sig` files
(`TAURI_SIGNING_PRIVATE_KEY`, see `UPDATES.md`). Those prove an update came
from us to the installed app. Authenticode proves it to Windows. Releases
carry both, and the minisign signature is made over the Authenticode-signed
installer.

## How the build signs

- `apps/desktop/src-tauri/tauri.conf.json` sets `bundle.windows.signCommand`
  to `windows/sign.ps1`. Tauri runs it on `REDBEAM.exe`, the NSIS installer
  and the uninstaller.
- `sign.ps1` calls `signtool sign` with Microsoft's Artifact Signing dlib
  (`Azure.CodeSigning.Dlib.dll`), SHA-256, timestamped by
  `http://timestamp.acs.microsoft.com`, then `signtool verify /pa`.
  Without `REDBEAM_SIGN_DLIB` and `REDBEAM_SIGN_METADATA` it prints a note and
  leaves the file unsigned, so local builds and `scripts/build-arm64.cmd` work
  as before.
- `.github/workflows/release.yml` checks for the six settings below. With all
  six it installs .NET 10, downloads the pinned
  `Microsoft.ArtifactSigning.Client` package (hash checked), writes
  `metadata.json` and builds. After the build it fails the run unless the
  installer and `REDBEAM.exe` have a valid, timestamped signature. With none
  of them the run warns and ships unsigned. With some but not all it fails.

## Settings (GitHub, Settings > Secrets and variables > Actions)

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `AZURE_TENANT_ID` | Directory (tenant) ID of the app registration |
| Secret | `AZURE_CLIENT_ID` | Application (client) ID of the app registration |
| Secret | `AZURE_CLIENT_SECRET` | The client secret **Value** (not its ID) |
| Variable | `ARTIFACT_SIGNING_ENDPOINT` | Account endpoint, for example `https://eus.codesigning.azure.net` |
| Variable | `ARTIFACT_SIGNING_ACCOUNT` | Artifact Signing account name |
| Variable | `ARTIFACT_SIGNING_PROFILE` | Certificate profile name |

The client secret expires (24 months at most). When it does, releases fail at
signing. Make a new secret on the same app registration and replace
`AZURE_CLIENT_SECRET`.

## One-time Azure setup

Microsoft Artifact Signing (called Trusted Signing until 2025) is about
US$10 a month on the Basic plan (5,000 signatures; a release uses about six).
Microsoft keeps the key, so there is no USB token and nothing to renew by hand.
Public-trust identity validation is open to organisations in the US, Canada,
the EU and the UK with at least three years of verifiable history, and to
individuals in the US and Canada.

1. **Azure subscription.** Sign in at https://portal.azure.com. Without a
   subscription, create a pay-as-you-go one (card required).
2. **Register the provider.** Subscriptions > your subscription > Settings >
   Resource providers > `Microsoft.CodeSigning` > Register.
3. **Create the account.** Search the portal for *Artifact Signing* (or
   *Trusted Signing*) > Create. New resource group `redbeam-signing`, a name
   such as `redbeam`, region **East US**, pricing **Basic**. Its Overview page
   shows the **Account URI**: that is `ARTIFACT_SIGNING_ENDPOINT`.
4. **Let yourself request validation.** On the account, Access control (IAM) >
   Add role assignment > *Artifact Signing Identity Verifier* (older name:
   *Trusted Signing Identity Verifier*) > your own user.
5. **Validate the publisher.** On the account, Identity validations > New >
   **Public**. Choose *Organization* for Maxxit (legal name, registration
   number, website, a work email on the company domain) or *Individual* for
   yourself (government ID and a selfie through Microsoft's verifier). The
   validated name is what Windows shows as the publisher. It usually takes one
   to a few business days, and Microsoft may email for documents.
6. **Certificate profile.** When the validation reads *Completed*: Certificate
   profiles > Create > **Public Trust**, name `redbeam`, pick that validation.
   That name is `ARTIFACT_SIGNING_PROFILE`; the account name is
   `ARTIFACT_SIGNING_ACCOUNT`.
7. **An identity for GitHub Actions.** Microsoft Entra ID > App registrations
   > New registration, name `redbeam-release-signing`, single tenant, no
   redirect URI. From its Overview copy the Directory (tenant) ID and the
   Application (client) ID. Certificates & secrets > New client secret (24
   months) and copy its **Value** straight away.
8. **Let that identity sign.** Back on the Artifact Signing account, Access
   control (IAM) > Add role assignment > *Artifact Signing Certificate Profile
   Signer* (older name: *Trusted Signing Certificate Profile Signer*) >
   Members: User, group, or service principal > `redbeam-release-signing`.
9. **GitHub.** Add the three secrets and three variables in the table above to
   the repository.

The next release run is signed. In its log, *Require Authenticode signatures*
prints the signer for each file. On a PC, right-click the installer >
Properties > Digital Signatures.

## If Artifact Signing is not available

Neither the organisation nor the individual route qualifies (outside those
countries, or a company younger than three years): buy an OV code-signing
certificate whose key lives in the vendor's cloud signing service (SSL.com
eSigner, Certum SimplySign and similar) and point `sign.ps1` at that vendor's
signing tool instead of the dlib. Everything else here stays the same.

## What signing does not fix

A signed installer clears Smart App Control and, after it gathers a little
reputation, SmartScreen. An organisation-managed PC whose policy only allows
listed publishers or listed paths may still refuse it. That PC's IT admin has
to allow the publisher (the validated name above) or the file.
