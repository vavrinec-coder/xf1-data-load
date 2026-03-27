# Railway Setup

This folder is the first vendor-hosted backend slice for the XF1 pilot.

## What it does

- runs a small Node backend on Railway
- connects to Railway Postgres
- starts Zoho OAuth for a specific XF1 user
- stores one Zoho connection per user-company pair

## Railway service settings

Use this folder as the service root:

- `cloud-backend`

## Required environment variables

- `PUBLIC_BASE_URL`
- `SESSION_SECRET`
- `ZOHO_CLIENT_ID`
- `ZOHO_CLIENT_SECRET`
- `ZOHO_REDIRECT_URI`
- `ZOHO_ACCOUNTS_BASE_URL`
- `ZOHO_BOOKS_BASE_URL`

Railway should inject:

- `DATABASE_URL`
- `PORT`

## Suggested initial values

- `ZOHO_ACCOUNTS_BASE_URL=https://accounts.zoho.in`
- `ZOHO_BOOKS_BASE_URL=https://www.zohoapis.in/books/v3`

## Important

Set `ZOHO_REDIRECT_URI` to:

- `https://<your-railway-domain>/auth/zoho/callback`

Set `PUBLIC_BASE_URL` to:

- `https://<your-railway-domain>`

## Smoke tests

After deploy:

- `GET /health`
- `GET /users/test-user/connections`
- `GET /auth/zoho/start?user_id=test-user`
