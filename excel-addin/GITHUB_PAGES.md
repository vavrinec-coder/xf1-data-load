# GitHub Pages Hosting

This add-in now supports a hosted frontend on GitHub Pages while keeping the XF1 desktop companion local on each user machine.

## What gets hosted

The Excel add-in web assets in `excel-addin/dist`:

- `taskpane.html`
- `taskpane.js`
- `functions.js`
- `functions.json`
- icons and support page
- a production `manifest.xml`

## What stays local

- `index.js`
- `db.js`
- `zoho-cache.sqlite`
- `zoho-tokens.json`
- Zoho OAuth callback on `http://localhost:3000`

## Deployment flow

1. Push changes to `main`.
2. Enable GitHub Pages for this repo and set the source to **GitHub Actions**.
3. The workflow `.github/workflows/deploy-addin-pages.yml` will publish the add-in frontend to:
   - `https://vavrinec-coder.github.io/xf1-data-load`
4. Download the production manifest from the built artifact or the published bundle and distribute that manifest to users.

## Local development

Keep using:

- `node index.js` from the repo root
- `npm start` from `excel-addin`

That continues to use `https://localhost:3001` for the add-in UI and `http://localhost:3000` for the local companion.

## Production manifest

The production build rewrites every `https://localhost:3001` manifest URL to:

- `https://vavrinec-coder.github.io/xf1-data-load`

It also uses:

- public asset path `/xf1-data-load/`

If you later move to a custom domain or Azure Static Web Apps, set:

- `ADDIN_BASE_URL`
- `ADDIN_PUBLIC_PATH`

before running `npm run build:pages`.
