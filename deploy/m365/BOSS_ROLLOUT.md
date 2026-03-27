# Boss Rollout

Use this package for the first proper test on another machine.

## 1. Microsoft 365 admin center

Upload this manifest:

- `deploy/m365/xf1-excel-addin-production-manifest.xml`

Assign it to the target user in Microsoft 365 admin center.

## 2. What central deployment does

It deploys the Excel add-in only:

- hosted task pane
- hosted custom functions metadata and script
- ribbon button / task pane entry

It does **not** install the local XF1 desktop companion.

## 3. What the user still needs locally

The user must have the XF1 local companion running on the machine because it handles:

- Zoho OAuth callback on `http://localhost:3000`
- local SQLite cache
- sync and normalization
- `ACC_VAL` lookups from Excel

## 4. User flow

1. Open Excel.
2. Open the `XF1 Panel`.
3. Click `Connect Zoho`.
4. Sign in to the user's own Zoho Books account in the browser.
5. Return to Excel and click `Sync Accounting Data`.
6. Use:
   - `=XF1.ACC_VAL("Sales","2026-01")`

## 5. Hosted frontend

The production manifest points to:

- `https://vavrinec-coder.github.io/xf1-data-load/taskpane.html`

## 6. Important limitation right now

This rollout is only half-packaged until the local companion is turned into a proper installer or background app.
