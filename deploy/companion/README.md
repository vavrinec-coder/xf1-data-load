# XF1 Desktop Companion Packaging

This folder creates a testable Windows companion bundle for another user machine.

## Build locally

From the repo root:

```powershell
npm run build:companion-bundle
```

That creates:

- `deploy/companion/out/XF1-Desktop-Companion`

## Bundle contents

- app source files
- `node_modules`
- `node.exe`
- start/stop scripts
- local `.env` copied from the current machine

## Important

The generated bundle is intentionally ignored by git because it includes:

- your local `.env`
- runtime-ready dependencies

Do not commit or publish the generated bundle.
