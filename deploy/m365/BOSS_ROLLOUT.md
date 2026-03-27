# Pilot Rollout

Use this package for the first colleague pilot on the cloud-backed version.

## 1. Microsoft 365 admin center

Upload this manifest:

- `deploy/m365/xf1-excel-addin-production-manifest.xml`

Assign it to the target user in Microsoft 365 admin center.

## 2. What central deployment does

It deploys the Excel add-in:

- hosted task pane
- hosted custom functions metadata and script
- ribbon button / task pane entry

## 3. What the user needs

The user does **not** need the legacy local companion for the pilot flow.

The user does need:

- Excel desktop
- access to the admin-deployed add-in
- their own Zoho Books account

## 4. User flow

1. Open Excel.
2. Open the `XF1 Panel`.
3. Save `Cloud Identity` using work email.
4. Click `Connect Zoho`.
5. Sign in to the user's own Zoho Books account in the browser.
6. Return to Excel and click `Sync Accounting Data`.
7. Use:
   - `=XF1.ACC_VAL("Sales","2026-01")`

## 5. Hosted services

The add-in frontend is hosted at:

- `https://vavrinec-coder.github.io/xf1-data-load/taskpane.html`

The cloud backend is hosted at:

- `https://xf1-data-load-production.up.railway.app`

## 6. Current pilot limitations

- User identity is currently based on the email saved in `Cloud Identity`
- the active Zoho company is the most recently connected company for that user
- there is not yet a polished sign-in or company-switching experience
