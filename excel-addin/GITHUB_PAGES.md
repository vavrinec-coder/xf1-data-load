# GitHub Pages Hosting

This add-in uses:

- GitHub Pages for the hosted Excel add-in frontend
- Railway for the pilot cloud backend

## What gets hosted on GitHub Pages

The Excel add-in web assets in `excel-addin/dist`:

- `taskpane.html`
- `taskpane.js`
- `functions.js`
- `functions.json`
- icons and support page
- a production `manifest.xml`

## What is hosted on Railway

The pilot cloud backend:

- Zoho OAuth flow
- per-user Zoho connection records
- cloud sync and normalization
- cached `ACC_VAL` lookups

## Deployment flow

1. Push changes to `main`.
2. GitHub Actions publishes the add-in frontend to:
   - `https://vavrinec-coder.github.io/xf1-data-load`
3. Railway deploys the backend from:
   - `cloud-backend`
4. Microsoft 365 admin center uses:
   - `deploy/m365/xf1-excel-addin-production-manifest.xml`

## Local development

Keep using:

- `node index.js` from the repo root for the legacy local prototype
- `npm start` from `excel-addin` for add-in development

The active pilot path, however, is now cloud-backed.

## Production manifest

The production build rewrites every `https://localhost:3001` manifest URL to:

- `https://vavrinec-coder.github.io/xf1-data-load`

It also allows the pilot backend domain:

- `https://xf1-data-load-production.up.railway.app`
