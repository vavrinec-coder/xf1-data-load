# XF1 Pilot Operating Playbook

This note captures the working operational model for the current XF1 Zoho-to-Excel pilot.

## Active architecture

- Excel add-in is admin-deployed.
- Add-in frontend is hosted on GitHub Pages.
- Zoho connect, sync, and value lookup run through the Railway cloud backend.
- `XF1.ACC_VAL(account_name, period)` is cloud-backed.
- The local desktop companion is legacy prototype code and is not the default pilot path.

## Safe operating sequence

For a normal user flow:
1. Open the add-in.
2. Save `Cloud Identity`.
3. Run `Connect Zoho`.
4. Run `Sync Accounting Data`.
5. Use `XF1.ACC_VAL(...)` in the workbook.

For a test-data change:
1. Post or adjust the Zoho entry.
2. Verify the entry exists in Zoho.
3. Trigger cloud sync.
4. Verify the expected value through the cloud backend.
5. Recalculate and verify the value in live Excel.

## Critical lessons learned

- Do not treat raw `.xlsx` custom-function cache as the source of truth.
- For Office add-in formulas, trust live Excel values after recalculation.
- If a portable file with literal values is needed, use `Replace with Values` or create a hard-pasted copy.
- If Excel shows a dev/sideload add-in error while the cloud add-in is also installed, remove stale dev registration first.
- If Microsoft 365 admin center rejects a manifest update, bump the manifest version and retry.

## Current endpoints

- GitHub Pages add-in:
  - `https://vavrinec-coder.github.io/xf1-data-load/taskpane.html`
- Railway backend:
  - `https://xf1-data-load-production.up.railway.app`

## Key files

- Manifest:
  - `deploy/m365\xf1-excel-addin-production-manifest.xml`
- Colleague onboarding:
  - `deploy/pilot/COLLEAGUE_ONBOARDING.md`
- Known limitations:
  - `deploy/pilot/KNOWN_LIMITATIONS.md`

## Formula semantics

- P&L accounts return monthly movement.
- Balance sheet accounts return month-end balance.
- Signs use raw accounting sign.
