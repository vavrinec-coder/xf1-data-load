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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_dim (
      xf1_user_id TEXT NOT NULL REFERENCES xf1_user(id) ON DELETE CASCADE,
      zoho_organization_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      account_name TEXT NOT NULL,
      account_type TEXT NOT NULL,
      statement_type TEXT NOT NULL,
      parent_account TEXT,
      account_code TEXT,
      account_status TEXT,
      currency TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (xf1_user_id, zoho_organization_id, account_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS journal_line_cache (
      xf1_user_id TEXT NOT NULL REFERENCES xf1_user(id) ON DELETE CASCADE,
      zoho_organization_id TEXT NOT NULL,
      line_id TEXT NOT NULL,
      journal_id TEXT NOT NULL,
      journal_date TEXT NOT NULL,
      period TEXT NOT NULL,
      reference_number TEXT,
      account_id TEXT,
      account_name TEXT NOT NULL,
      debit_or_credit TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      signed_amount NUMERIC NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (xf1_user_id, zoho_organization_id, line_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_period_cache (
      xf1_user_id TEXT NOT NULL REFERENCES xf1_user(id) ON DELETE CASCADE,
      zoho_organization_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      account_name TEXT NOT NULL,
      account_type TEXT NOT NULL,
      statement_type TEXT NOT NULL,
      period TEXT NOT NULL,
      monthly_movement NUMERIC NOT NULL,
      month_end_balance NUMERIC,
      entry_count INTEGER NOT NULL,
      refreshed_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (xf1_user_id, zoho_organization_id, account_id, period)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS posting_line_fact (
      xf1_user_id TEXT NOT NULL REFERENCES xf1_user(id) ON DELETE CASCADE,
      zoho_organization_id TEXT NOT NULL,
      source_module TEXT NOT NULL,
      source_txn_id TEXT NOT NULL,
      source_line_id TEXT NOT NULL,
      posting_date TEXT NOT NULL,
      period TEXT NOT NULL,
      account_id TEXT NOT NULL,
      account_name TEXT NOT NULL,
      account_type TEXT NOT NULL,
      statement_type TEXT NOT NULL,
      debit_or_credit TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      signed_amount_raw NUMERIC NOT NULL,
      reference_number TEXT,
      description TEXT,
      department_tag_id TEXT,
      department_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (xf1_user_id, zoho_organization_id, source_module, source_line_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_period_department_cache (
      xf1_user_id TEXT NOT NULL REFERENCES xf1_user(id) ON DELETE CASCADE,
      zoho_organization_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      account_name TEXT NOT NULL,
      account_type TEXT NOT NULL,
      statement_type TEXT NOT NULL,
      period TEXT NOT NULL,
      department_tag_id TEXT,
      department_name TEXT,
      monthly_movement_raw NUMERIC NOT NULL,
      month_end_balance_raw NUMERIC,
      entry_count INTEGER NOT NULL,
      refreshed_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (xf1_user_id, zoho_organization_id, account_id, period, department_name)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_state (
      xf1_user_id TEXT NOT NULL REFERENCES xf1_user(id) ON DELETE CASCADE,
      zoho_organization_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (xf1_user_id, zoho_organization_id, key)
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
      ON CONFLICT (state) DO UPDATE
      SET xf1_user_id = EXCLUDED.xf1_user_id, created_at = NOW()
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

async function updateZohoConnectionTokens(connectionId, accessToken, refreshToken = null) {
  await pool.query(
    `
      UPDATE zoho_connection
      SET
        access_token = $2,
        refresh_token = COALESCE($3, refresh_token),
        updated_at = NOW()
      WHERE id = $1
    `,
    [connectionId, accessToken, refreshToken]
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

async function getPrimaryConnectionForUser(userId) {
  const result = await pool.query(
    `
      SELECT
        id,
        xf1_user_id,
        zoho_accounts_base_url,
        zoho_books_base_url,
        zoho_organization_id,
        zoho_organization_name,
        refresh_token,
        access_token,
        connected_email,
        status,
        created_at,
        updated_at
      FROM zoho_connection
      WHERE xf1_user_id = $1
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [userId]
  );

  return result.rows[0] || null;
}

async function replaceUserOrgCache({
  userId,
  organizationId,
  accountRows,
  lineRows,
  periodRows,
  postingLineRows = [],
  departmentPeriodRows = [],
  refreshedAt,
  summary,
}) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `DELETE FROM account_dim WHERE xf1_user_id = $1 AND zoho_organization_id = $2`,
      [userId, organizationId]
    );
    await client.query(
      `DELETE FROM journal_line_cache WHERE xf1_user_id = $1 AND zoho_organization_id = $2`,
      [userId, organizationId]
    );
    await client.query(
      `DELETE FROM account_period_cache WHERE xf1_user_id = $1 AND zoho_organization_id = $2`,
      [userId, organizationId]
    );
    await client.query(
      `DELETE FROM posting_line_fact WHERE xf1_user_id = $1 AND zoho_organization_id = $2`,
      [userId, organizationId]
    );
    await client.query(
      `DELETE FROM account_period_department_cache WHERE xf1_user_id = $1 AND zoho_organization_id = $2`,
      [userId, organizationId]
    );
    await client.query(
      `DELETE FROM sync_state WHERE xf1_user_id = $1 AND zoho_organization_id = $2`,
      [userId, organizationId]
    );

    for (const row of accountRows) {
      await client.query(
        `
          INSERT INTO account_dim (
            xf1_user_id,
            zoho_organization_id,
            account_id,
            account_name,
            account_type,
            statement_type,
            parent_account,
            account_code,
            account_status,
            currency
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `,
        [
          userId,
          organizationId,
          row.account_id,
          row.account_name,
          row.account_type,
          row.statement_type,
          row.parent_account,
          row.account_code,
          row.account_status,
          row.currency,
        ]
      );
    }

    for (const row of lineRows) {
      await client.query(
        `
          INSERT INTO journal_line_cache (
            xf1_user_id,
            zoho_organization_id,
            line_id,
            journal_id,
            journal_date,
            period,
            reference_number,
            account_id,
            account_name,
            debit_or_credit,
            amount,
            signed_amount,
            description
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        `,
        [
          userId,
          organizationId,
          row.line_id,
          row.journal_id,
          row.journal_date,
          row.period,
          row.reference_number,
          row.account_id,
          row.account_name,
          row.debit_or_credit,
          row.amount,
          row.signed_amount,
          row.description,
        ]
      );
    }

    for (const row of periodRows) {
      await client.query(
        `
          INSERT INTO account_period_cache (
            xf1_user_id,
            zoho_organization_id,
            account_id,
            account_name,
            account_type,
            statement_type,
            period,
            monthly_movement,
            month_end_balance,
            entry_count,
            refreshed_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `,
        [
          userId,
          organizationId,
          row.account_id,
          row.account_name,
          row.account_type,
          row.statement_type,
          row.period,
          row.monthly_movement,
          row.month_end_balance,
          row.entry_count,
          refreshedAt,
        ]
      );
    }

    for (const row of postingLineRows) {
      await client.query(
        `
          INSERT INTO posting_line_fact (
            xf1_user_id,
            zoho_organization_id,
            source_module,
            source_txn_id,
            source_line_id,
            posting_date,
            period,
            account_id,
            account_name,
            account_type,
            statement_type,
            debit_or_credit,
            amount,
            signed_amount_raw,
            reference_number,
            description,
            department_tag_id,
            department_name
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        `,
        [
          userId,
          organizationId,
          row.source_module,
          row.source_txn_id,
          row.source_line_id,
          row.posting_date,
          row.period,
          row.account_id,
          row.account_name,
          row.account_type,
          row.statement_type,
          row.debit_or_credit,
          row.amount,
          row.signed_amount_raw,
          row.reference_number,
          row.description,
          row.department_tag_id,
          row.department_name,
        ]
      );
    }

    for (const row of departmentPeriodRows) {
      await client.query(
        `
          INSERT INTO account_period_department_cache (
            xf1_user_id,
            zoho_organization_id,
            account_id,
            account_name,
            account_type,
            statement_type,
            period,
            department_tag_id,
            department_name,
            monthly_movement_raw,
            month_end_balance_raw,
            entry_count,
            refreshed_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        `,
        [
          userId,
          organizationId,
          row.account_id,
          row.account_name,
          row.account_type,
          row.statement_type,
          row.period,
          row.department_tag_id,
          row.department_name,
          row.monthly_movement_raw,
          row.month_end_balance_raw,
          row.entry_count,
          refreshedAt,
        ]
      );
    }

    await client.query(
      `
        INSERT INTO sync_state (xf1_user_id, zoho_organization_id, key, value)
        VALUES ($1,$2,'last_refresh_at',$3)
      `,
      [userId, organizationId, refreshedAt]
    );
    await client.query(
      `
        INSERT INTO sync_state (xf1_user_id, zoho_organization_id, key, value)
        VALUES ($1,$2,'last_refresh_summary',$3)
      `,
      [userId, organizationId, JSON.stringify(summary)]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getCacheStatus(userId, organizationId) {
  const countsResult = await pool.query(
    `
      SELECT
        (SELECT COUNT(*) FROM account_dim WHERE xf1_user_id = $1 AND zoho_organization_id = $2) AS account_dim_count,
        (SELECT COUNT(*) FROM journal_line_cache WHERE xf1_user_id = $1 AND zoho_organization_id = $2) AS journal_line_count,
        (SELECT COUNT(*) FROM account_period_cache WHERE xf1_user_id = $1 AND zoho_organization_id = $2) AS account_period_count,
        (SELECT COUNT(*) FROM posting_line_fact WHERE xf1_user_id = $1 AND zoho_organization_id = $2) AS posting_line_fact_count,
        (SELECT COUNT(*) FROM account_period_department_cache WHERE xf1_user_id = $1 AND zoho_organization_id = $2) AS account_period_department_count
    `,
    [userId, organizationId]
  );

  const syncResult = await pool.query(
    `
      SELECT key, value
      FROM sync_state
      WHERE xf1_user_id = $1 AND zoho_organization_id = $2
    `,
    [userId, organizationId]
  );

  const syncMap = new Map(syncResult.rows.map((row) => [row.key, row.value]));

  return {
    last_refresh_at: syncMap.get("last_refresh_at") || null,
    last_refresh_summary: syncMap.get("last_refresh_summary")
      ? JSON.parse(syncMap.get("last_refresh_summary"))
      : null,
    account_dim_count: Number(countsResult.rows[0]?.account_dim_count || 0),
    journal_line_count: Number(countsResult.rows[0]?.journal_line_count || 0),
    account_period_count: Number(countsResult.rows[0]?.account_period_count || 0),
    posting_line_fact_count: Number(countsResult.rows[0]?.posting_line_fact_count || 0),
    account_period_department_count: Number(countsResult.rows[0]?.account_period_department_count || 0),
  };
}

async function getAccountPeriodValue(userId, organizationId, accountName, period) {
  const result = await pool.query(
    `
      SELECT
        account_id,
        account_name,
        account_type,
        statement_type,
        period,
        monthly_movement,
        month_end_balance,
        entry_count,
        refreshed_at
      FROM account_period_cache
      WHERE xf1_user_id = $1 AND zoho_organization_id = $2 AND account_name = $3 AND period = $4
      LIMIT 1
    `,
    [userId, organizationId, accountName, period]
  );

  return result.rows[0] || null;
}

async function getDepartmentAccountPeriodValue(userId, organizationId, accountName, period, departmentName) {
  const result = await pool.query(
    `
      SELECT
        account_id,
        account_name,
        account_type,
        statement_type,
        period,
        department_tag_id,
        department_name,
        monthly_movement_raw,
        month_end_balance_raw,
        entry_count,
        refreshed_at
      FROM account_period_department_cache
      WHERE
        xf1_user_id = $1
        AND zoho_organization_id = $2
        AND account_name = $3
        AND period = $4
        AND department_name = $5
      LIMIT 1
    `,
    [userId, organizationId, accountName, period, departmentName]
  );

  return result.rows[0] || null;
}

async function dbHealth() {
  const result = await pool.query("SELECT NOW() AS now");
  return result.rows[0];
}

async function exportUserOrgRows(userId, organizationId, tableName) {
  const allowed = new Set([
    "account_dim",
    "journal_line_cache",
    "account_period_cache",
    "posting_line_fact",
    "account_period_department_cache",
    "sync_state",
  ]);
  if (!allowed.has(tableName)) {
    throw new Error(`Unsupported export table: ${tableName}`);
  }

  const result = await pool.query(
    `
      SELECT *
      FROM ${tableName}
      WHERE xf1_user_id = $1 AND zoho_organization_id = $2
      ORDER BY 1, 2, 3
    `,
    [userId, organizationId]
  );

  return result.rows;
}

module.exports = {
  pool,
  migrate,
  ensureUser,
  saveOauthState,
  consumeOauthState,
  upsertZohoConnection,
  updateZohoConnectionTokens,
  getConnectionsForUser,
  getPrimaryConnectionForUser,
  replaceUserOrgCache,
  getCacheStatus,
  getAccountPeriodValue,
  getDepartmentAccountPeriodValue,
  dbHealth,
  exportUserOrgRows,
};
