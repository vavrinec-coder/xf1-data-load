const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required for the cloud backend.");
}

const sslMode = process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false };

const pool = new Pool({
  connectionString,
  ssl: sslMode,
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS xf1_user (
      id TEXT PRIMARY KEY,
      email TEXT,
      display_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS zoho_connection (
      id BIGSERIAL PRIMARY KEY,
      xf1_user_id TEXT NOT NULL REFERENCES xf1_user(id) ON DELETE CASCADE,
      zoho_accounts_base_url TEXT NOT NULL,
      zoho_books_base_url TEXT NOT NULL,
      zoho_organization_id TEXT,
      zoho_organization_name TEXT,
      refresh_token TEXT,
      access_token TEXT,
      connected_email TEXT,
      status TEXT NOT NULL DEFAULT 'connected',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (xf1_user_id, zoho_organization_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_state (
      state TEXT PRIMARY KEY,
      xf1_user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function ensureUser(userId, email = null, displayName = null) {
  await pool.query(
    `
      INSERT INTO xf1_user (id, email, display_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO UPDATE
      SET
        email = COALESCE(EXCLUDED.email, xf1_user.email),
        display_name = COALESCE(EXCLUDED.display_name, xf1_user.display_name),
        updated_at = NOW()
    `,
    [userId, email, displayName]
  );
}

async function saveOauthState(state, userId) {
  await pool.query(
    `
      INSERT INTO oauth_state (state, xf1_user_id)
      VALUES ($1, $2)
      ON CONFLICT (state) DO UPDATE SET xf1_user_id = EXCLUDED.xf1_user_id, created_at = NOW()
    `,
    [state, userId]
  );
}

async function consumeOauthState(state) {
  const result = await pool.query(
    `
      DELETE FROM oauth_state
      WHERE state = $1
      RETURNING xf1_user_id
    `,
    [state]
  );

  return result.rows[0]?.xf1_user_id || null;
}

async function upsertZohoConnection({
  userId,
  accountsBaseUrl,
  booksBaseUrl,
  organizationId,
  organizationName,
  refreshToken,
  accessToken,
  connectedEmail,
}) {
  await pool.query(
    `
      INSERT INTO zoho_connection (
        xf1_user_id,
        zoho_accounts_base_url,
        zoho_books_base_url,
        zoho_organization_id,
        zoho_organization_name,
        refresh_token,
        access_token,
        connected_email,
        status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'connected')
      ON CONFLICT (xf1_user_id, zoho_organization_id) DO UPDATE
      SET
        zoho_accounts_base_url = EXCLUDED.zoho_accounts_base_url,
        zoho_books_base_url = EXCLUDED.zoho_books_base_url,
        zoho_organization_name = EXCLUDED.zoho_organization_name,
        refresh_token = COALESCE(EXCLUDED.refresh_token, zoho_connection.refresh_token),
        access_token = EXCLUDED.access_token,
        connected_email = COALESCE(EXCLUDED.connected_email, zoho_connection.connected_email),
        status = 'connected',
        updated_at = NOW()
    `,
    [userId, accountsBaseUrl, booksBaseUrl, organizationId, organizationName, refreshToken, accessToken, connectedEmail]
  );
}

async function getConnectionsForUser(userId) {
  const result = await pool.query(
    `
      SELECT
        id,
        xf1_user_id,
        zoho_organization_id,
        zoho_organization_name,
        connected_email,
        status,
        created_at,
        updated_at
      FROM zoho_connection
      WHERE xf1_user_id = $1
      ORDER BY updated_at DESC
    `,
    [userId]
  );

  return result.rows;
}

async function dbHealth() {
  const result = await pool.query("SELECT NOW() AS now");
  return result.rows[0];
}

module.exports = {
  pool,
  migrate,
  ensureUser,
  saveOauthState,
  consumeOauthState,
  upsertZohoConnection,
  getConnectionsForUser,
  dbHealth,
};
