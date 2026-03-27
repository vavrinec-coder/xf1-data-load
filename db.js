const Database = require("better-sqlite3");
const { dbPath } = require("./app-paths");

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS journal_line_cache (
    line_id TEXT PRIMARY KEY,
    journal_id TEXT NOT NULL,
    journal_date TEXT NOT NULL,
    period TEXT NOT NULL,
    reference_number TEXT,
    account_id TEXT,
    account_name TEXT NOT NULL,
    debit_or_credit TEXT NOT NULL,
    amount REAL NOT NULL,
    signed_amount REAL NOT NULL,
    description TEXT
  );

  CREATE TABLE IF NOT EXISTS account_dim (
    account_id TEXT PRIMARY KEY,
    account_name TEXT NOT NULL,
    account_type TEXT NOT NULL,
    statement_type TEXT NOT NULL,
    parent_account TEXT,
    account_code TEXT,
    account_status TEXT,
    currency TEXT
  );

  CREATE TABLE IF NOT EXISTS account_period_cache (
    account_id TEXT NOT NULL,
    account_name TEXT NOT NULL,
    account_type TEXT NOT NULL,
    statement_type TEXT NOT NULL,
    period TEXT NOT NULL,
    monthly_movement REAL NOT NULL,
    month_end_balance REAL,
    entry_count INTEGER NOT NULL,
    refreshed_at TEXT NOT NULL,
    PRIMARY KEY (account_id, period)
  );

  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

const deleteJournalLines = db.prepare("DELETE FROM journal_line_cache");
const deleteAccountDim = db.prepare("DELETE FROM account_dim");
const deleteAccountPeriods = db.prepare("DELETE FROM account_period_cache");
const insertJournalLine = db.prepare(`
  INSERT INTO journal_line_cache (
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
  ) VALUES (
    @line_id,
    @journal_id,
    @journal_date,
    @period,
    @reference_number,
    @account_id,
    @account_name,
    @debit_or_credit,
    @amount,
    @signed_amount,
    @description
  )
`);
const insertAccountDim = db.prepare(`
  INSERT INTO account_dim (
    account_id,
    account_name,
    account_type,
    statement_type,
    parent_account,
    account_code,
    account_status,
    currency
  ) VALUES (
    @account_id,
    @account_name,
    @account_type,
    @statement_type,
    @parent_account,
    @account_code,
    @account_status,
    @currency
  )
`);
const insertAccountPeriod = db.prepare(`
  INSERT INTO account_period_cache (
    account_id,
    account_name,
    account_type,
    statement_type,
    period,
    monthly_movement,
    month_end_balance,
    entry_count,
    refreshed_at
  ) VALUES (
    @account_id,
    @account_name,
    @account_type,
    @statement_type,
    @period,
    @monthly_movement,
    @month_end_balance,
    @entry_count,
    @refreshed_at
  )
`);
const upsertSyncState = db.prepare(`
  INSERT INTO sync_state (key, value)
  VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);
const selectAccountPeriod = db.prepare(`
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
  WHERE account_name = ? AND period = ?
`);
const selectCachedEntries = db.prepare(`
  SELECT journal_date, reference_number, debit_or_credit, amount, signed_amount, description
  FROM journal_line_cache
  WHERE account_name = ? AND period = ?
  ORDER BY journal_date, reference_number, line_id
`);
const selectSyncValue = db.prepare("SELECT value FROM sync_state WHERE key = ?");
const selectCacheCounts = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM account_dim) AS account_dim_count,
    (SELECT COUNT(*) FROM journal_line_cache) AS journal_line_count,
    (SELECT COUNT(*) FROM account_period_cache) AS account_period_count
`);

const refreshCacheTx = db.transaction((accountRows, lineRows, periodRows, refreshedAt, summary) => {
  deleteAccountDim.run();
  deleteJournalLines.run();
  deleteAccountPeriods.run();

  for (const row of accountRows) {
    insertAccountDim.run(row);
  }

  for (const row of lineRows) {
    insertJournalLine.run(row);
  }

  for (const row of periodRows) {
    insertAccountPeriod.run({
      ...row,
      refreshed_at: refreshedAt,
    });
  }

  upsertSyncState.run("last_refresh_at", refreshedAt);
  upsertSyncState.run("last_refresh_summary", JSON.stringify(summary));
});

function refreshCache(accountRows, lineRows, periodRows, refreshedAt, summary) {
  refreshCacheTx(accountRows, lineRows, periodRows, refreshedAt, summary);
}

function getAccountPeriodValue(accountName, period) {
  return selectAccountPeriod.get(accountName, period) || null;
}

function getCachedEntries(accountName, period) {
  return selectCachedEntries.all(accountName, period);
}

function getCacheStatus() {
  const counts = selectCacheCounts.get();
  const lastRefreshAt = selectSyncValue.get("last_refresh_at")?.value || null;
  const lastRefreshSummaryRaw = selectSyncValue.get("last_refresh_summary")?.value || null;

  return {
    db_path: dbPath,
    last_refresh_at: lastRefreshAt,
    last_refresh_summary: lastRefreshSummaryRaw ? JSON.parse(lastRefreshSummaryRaw) : null,
    ...counts,
  };
}

module.exports = {
  dbPath,
  refreshCache,
  getAccountPeriodValue,
  getCachedEntries,
  getCacheStatus,
};
