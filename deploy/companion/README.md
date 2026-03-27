# XF1 Desktop Companion Packaging

This folder creates a testable Windows companion bundle for another user machine.

## Build locally

From the repo root:

```powershell
npm run build:companion-bundle
```

That creates:

- `deploy/companion/out/XF1-Desktop-Companion`
- `deploy/companion/out/XF1-Desktop-Companion.zip`

## Bundle contents

- app source files
- `node_modules`
- `node.exe`
- start/stop scripts
- install/uninstall scripts
- local `.env` copied from the current machine

## Internal pilot install flow

On the target machine:

1. Extract `XF1-Desktop-Companion.zip`
2. Double-click:
   - `install-xf1-companion.cmd`

That installs the companion to:

- `%LOCALAPPDATA%\Programs\XF1 Desktop Companion`

It also:

- creates Start Menu shortcuts
- creates a desktop shortcut to start the companion
- starts the companion immediately

## Important

The generated bundle is intentionally ignored by git because it includes:

- your local `.env`
- runtime-ready dependencies

Do not commit or publish the generated bundle.
