const crypto = require("crypto");
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const dotenv = require("dotenv");
const {
  migrate,
  ensureUser,
  saveOauthState,
  consumeOauthState,
  upsertZohoConnection,
  getConnectionsForUser,
  dbHealth,
} = require("./db");

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);

const publicBaseUrl = process.env.PUBLIC_BASE_URL;
const clientId = process.env.ZOHO_CLIENT_ID;
const clientSecret = process.env.ZOHO_CLIENT_SECRET;
const redirectUri = process.env.ZOHO_REDIRECT_URI;
const accountsBaseUrl = process.env.ZOHO_ACCOUNTS_BASE_URL;
const booksBaseUrl = process.env.ZOHO_BOOKS_BASE_URL;

if (!publicBaseUrl || !clientId || !clientSecret || !redirectUri || !accountsBaseUrl || !booksBaseUrl) {
  throw new Error("Missing required cloud backend environment variables.");
}

app.use(express.json());
app.use(
  cors({
    origin: true,
  })
);

app.get("/", (_req, res) => {
  res.json({
    service: "xf1-cloud-backend",
    ok: true,
    public_base_url: publicBaseUrl,
  });
});

app.get("/health", async (_req, res) => {
  try {
    const db = await dbHealth();
    res.json({
      ok: true,
      service: "xf1-cloud-backend",
      public_base_url: publicBaseUrl,
      db_now: db.now,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/users/:userId/connections", async (req, res) => {
  try {
    const userId = String(req.params.userId || "").trim();
    if (!userId) {
      res.status(400).json({ error: "Missing userId." });
      return;
    }

    const connections = await getConnectionsForUser(userId);
    res.json({
      user_id: userId,
      count: connections.length,
      connections,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/auth/zoho/start", async (req, res) => {
  try {
    const userId = String(req.query.user_id || "").trim();
    const userEmail = String(req.query.email || "").trim() || null;
    const userName = String(req.query.name || "").trim() || null;

    if (!userId) {
      res.status(400).json({ error: "Provide user_id query parameter." });
      return;
    }

    await ensureUser(userId, userEmail, userName);

    const state = crypto.randomUUID();
    await saveOauthState(state, userId);

    const authUrl = new URL(`${accountsBaseUrl}/oauth/v2/auth`);
    authUrl.searchParams.set("scope", "ZohoBooks.fullaccess.all");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("state", state);

    res.redirect(authUrl.toString());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function getOrganizations(accessToken) {
  const response = await axios.get(`${booksBaseUrl}/organizations`, {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
  });

  return response.data.organizations || [];
}

app.get("/auth/zoho/callback", async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;

  if (!code || !state) {
    res.status(400).send("Missing code or state query parameters.");
    return;
  }

  try {
    const userId = await consumeOauthState(state);
    if (!userId) {
      res.status(400).send("OAuth state is invalid or expired.");
      return;
    }

    const tokenResponse = await axios.post(`${accountsBaseUrl}/oauth/v2/token`, null, {
      params: {
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      },
    });

    const { access_token, refresh_token } = tokenResponse.data;
    const organizations = await getOrganizations(access_token);
    const organization = organizations[0] || {};

    await upsertZohoConnection({
      userId,
      accountsBaseUrl,
      booksBaseUrl,
      organizationId: organization.organization_id || "unknown-org",
      organizationName: organization.name || "Unknown organization",
      refreshToken: refresh_token || null,
      accessToken: access_token,
      connectedEmail: organization.email || null,
    });

    res.send(`
      <h1>XF1 cloud backend connected to Zoho successfully</h1>
      <p>User ID: ${userId}</p>
      <p>Organization: ${organization.name || "Unknown organization"}</p>
      <p>Organization ID: ${organization.organization_id || "Unknown"}</p>
      <p>You can now return to Excel.</p>
    `);
  } catch (error) {
    const details = error.response?.data || error.message;
    res.status(500).send(`<pre>${JSON.stringify(details, null, 2)}</pre>`);
  }
});

async function start() {
  await migrate();
  app.listen(port, () => {
    console.log(`XF1 cloud backend listening on port ${port}`);
  });
}

start().catch((error) => {
  console.error("Failed to start XF1 cloud backend", error);
  process.exit(1);
});
