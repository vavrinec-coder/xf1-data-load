const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const {
  dbPath,
  refreshCache,
  getAccountPeriodValue,
  getCachedEntries,
  getCacheStatus,
} = require("./db");
require("dotenv").config();

const app = express();
const port = 3000;

const clientId = process.env.ZOHO_CLIENT_ID;
const clientSecret = process.env.ZOHO_CLIENT_SECRET;
const redirectUri = process.env.ZOHO_REDIRECT_URI;
const accountsBaseUrl = process.env.ZOHO_ACCOUNTS_BASE_URL;
const booksBaseUrl = process.env.ZOHO_BOOKS_BASE_URL;
const tokenFilePath = path.join(__dirname, "zoho-tokens.json");

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});

function saveTokens(payload) {
  fs.writeFileSync(tokenFilePath, JSON.stringify(payload, null, 2), "utf8");
}

function loadTokens() {
  if (!fs.existsSync(tokenFilePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(tokenFilePath, "utf8"));
}

async function getAccessToken() {
  const tokenData = loadTokens();
  if (!tokenData) {
    throw new Error("No token file found. Reconnect via /connect/zoho first.");
  }

  // Prototype fallback: use the current access token if we have one.
  if (!tokenData.refresh_token && tokenData.access_token) {
    return tokenData;
  }

  if (!tokenData.refresh_token) {
    throw new Error("No refresh token found. Reconnect via /connect/zoho first.");
  }

  const tokenResponse = await axios.post(`${accountsBaseUrl}/oauth/v2/token`, null, {
    params: {
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokenData.refresh_token,
    },
  });

  const updated = {
    ...tokenData,
    access_token: tokenResponse.data.access_token,
    access_token_received_at: new Date().toISOString(),
  };

  saveTokens(updated);
  return updated;
}

async function getOrganizations(accessToken) {
  const orgResponse = await axios.get(`${booksBaseUrl}/organizations`, {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
  });

  return orgResponse.data.organizations || [];
}

async function getDefaultOrganizationId(accessToken) {
  const tokenData = loadTokens();
  if (tokenData?.organization_id) {
    return tokenData.organization_id;
  }

  const organizations = await getOrganizations(accessToken);
  const organizationId = organizations[0]?.organization_id;

  if (!organizationId) {
    throw new Error("No Zoho Books organization returned.");
  }

  saveTokens({
    ...(tokenData || {}),
    organization_id: organizationId,
  });

  return organizationId;
}

async function fetchAllJournals(accessToken, organizationId) {
  const allJournals = [];
  let page = 1;
  const perPage = 200;

  while (true) {
    const response = await axios.get(`${booksBaseUrl}/journals`, {
      params: {
        organization_id: organizationId,
        page,
        per_page: perPage,
      },
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
      },
    });

    const journals = response.data.journals || [];
    allJournals.push(...journals);

    if (journals.length < perPage) {
      break;
    }

    page += 1;
  }

  return allJournals;
}

async function fetchJournalDetails(accessToken, organizationId, journalId) {
  const response = await axios.get(`${booksBaseUrl}/journals/${journalId}`, {
    params: {
      organization_id: organizationId,
    },
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
  });

  return response.data.journal;
}

async function fetchChartOfAccounts(accessToken, organizationId) {
  const response = await axios.get(`${booksBaseUrl}/chartofaccounts`, {
    params: {
      organization_id: organizationId,
    },
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
  });

  return response.data.chartofaccounts || [];
}

function getStatementType(accountType) {
  const normalized = String(accountType || "").trim().toLowerCase();
  const pnlTypes = new Set([
    "income",
    "other_income",
    "expense",
    "other_expense",
    "cost_of_goods_sold",
  ]);

  return pnlTypes.has(normalized) ? "p_and_l" : "balance_sheet";
}

function normalizeAccounts(accounts) {
  return accounts.map((account) => ({
    account_id: account.account_id,
    account_name: account.account_name,
    account_type: account.account_type,
    statement_type: getStatementType(account.account_type),
    parent_account: account.parent_account || "",
    account_code: account.account_code || "",
    account_status: account.account_status || "",
    currency: account.currency_code || account.currency || "",
  }));
}

function buildPeriodRange(periods) {
  if (!periods.length) {
    return [];
  }

  const [startYear, startMonth] = periods[0].split("-").map(Number);
  const [endYear, endMonth] = periods[periods.length - 1].split("-").map(Number);
  const result = [];
  let year = startYear;
  let month = startMonth;

  while (year < endYear || (year === endYear && month <= endMonth)) {
    result.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }

  return result;
}

function normalizeJournalLines(journals) {
  return journals.flatMap((journal) =>
    (journal.line_items || []).map((lineItem) => {
      const amount = Number(lineItem.amount || 0);
      const signedAmount = lineItem.debit_or_credit === "debit" ? amount : -amount;

      return {
        line_id: lineItem.line_id,
        journal_id: journal.journal_id,
        journal_date: journal.journal_date,
        period: journal.journal_date.slice(0, 7),
        reference_number: journal.reference_number || "",
        account_id: lineItem.account_id || "",
        account_name: lineItem.account_name,
        debit_or_credit: lineItem.debit_or_credit,
        amount,
        signed_amount: signedAmount,
        description: lineItem.description || "",
      };
    })
  );
}

function buildAccountPeriodRows(accountRows, lineRows, periods, refreshedAt) {
  const movementMap = new Map();

  for (const row of lineRows) {
    const key = `${row.account_id}::${row.period}`;
    const existing = movementMap.get(key) || {
      monthly_movement: 0,
      entry_count: 0,
    };

    existing.monthly_movement += row.signed_amount;
    existing.entry_count += 1;
    movementMap.set(key, existing);
  }

  return accountRows.flatMap((account) => {
    let closingBalance = 0;

    return periods.map((period) => {
      const movement = movementMap.get(`${account.account_id}::${period}`) || {
        monthly_movement: 0,
        entry_count: 0,
      };

      if (account.statement_type === "balance_sheet") {
        closingBalance += movement.monthly_movement;
      }

      return {
        account_id: account.account_id,
        account_name: account.account_name,
        account_type: account.account_type,
        statement_type: account.statement_type,
        period,
        monthly_movement: Number(movement.monthly_movement.toFixed(2)),
        month_end_balance:
          account.statement_type === "balance_sheet"
            ? Number(closingBalance.toFixed(2))
            : null,
        entry_count: movement.entry_count,
        refreshed_at: refreshedAt,
      };
    });
  });
}

app.get("/", (_req, res) => {
  res.send(`
    <h1>Zoho local prototype is running</h1>
    <ul>
      <li><a href="/connect/zoho">/connect/zoho</a></li>
      <li><a href="/zoho/chart-of-accounts">/zoho/chart-of-accounts</a></li>
      <li><a href="/zoho/refresh">/zoho/refresh</a></li>
      <li><a href="/cache/status">/cache/status</a></li>
    </ul>
    <p>Cache DB: ${dbPath}</p>
  `);
});

app.get("/connect/zoho", (_req, res) => {
  const authUrl = new URL(`${accountsBaseUrl}/oauth/v2/auth`);
  authUrl.searchParams.set("scope", "ZohoBooks.fullaccess.all");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  res.redirect(authUrl.toString());
});

app.get("/oauth/zoho/callback", async (req, res) => {
  const code = req.query.code;

  if (!code) {
    res.status(400).send("Missing code query parameter.");
    return;
  }

  try {
    const tokenResponse = await axios.post(
      `${accountsBaseUrl}/oauth/v2/token`,
      null,
      {
        params: {
          grant_type: "authorization_code",
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          code,
        },
      }
    );

    const { access_token, refresh_token } = tokenResponse.data;
    const organizations = await getOrganizations(access_token);
    const existingTokens = loadTokens() || {};
    saveTokens({
      refresh_token: refresh_token || existingTokens.refresh_token || null,
      access_token,
      access_token_received_at: new Date().toISOString(),
      organization_id: organizations[0]?.organization_id || null,
    });
    const orgSummary = organizations
      .map((org) => `${org.name} | organization_id=${org.organization_id}`)
      .join("<br>");

    res.send(`
      <h1>Zoho connection successful</h1>
      <p>Refresh token received: ${refresh_token ? "yes" : "no"}</p>
      <p>Organizations:</p>
      <div>${orgSummary || "None returned"}</div>
    `);
  } catch (error) {
    const details = error.response?.data || error.message;
    res.status(500).send(`<pre>${JSON.stringify(details, null, 2)}</pre>`);
  }
});

app.get("/zoho/chart-of-accounts", async (_req, res) => {
  try {
    const tokenData = await getAccessToken();
    const organizationId = await getDefaultOrganizationId(tokenData.access_token);
    const accounts = await fetchChartOfAccounts(tokenData.access_token, organizationId);
    res.json({
      organization_id: organizationId,
      count: accounts.length,
      accounts: accounts.map((account) => ({
        account_id: account.account_id,
        account_name: account.account_name,
        account_type: account.account_type,
      })),
    });
  } catch (error) {
    const details = error.response?.data || error.message;
    res.status(500).json(details);
  }
});

app.get("/zoho/create-opening-journal", async (req, res) => {
  const bankAccountId = req.query.bank_account_id;
  const equityAccountId = req.query.equity_account_id;

  if (!bankAccountId || !equityAccountId) {
    res.status(400).json({
      error: "Provide bank_account_id and equity_account_id query parameters.",
    });
    return;
  }

  try {
    const tokenData = await getAccessToken();
    const organizationId = await getDefaultOrganizationId(tokenData.access_token);

    const payload = {
      journal_date: "2026-01-01",
      reference_number: "OPENING-FUNDING",
      notes: "Opening funding for local prototype",
      line_items: [
        {
          account_id: bankAccountId,
          debit_or_credit: "debit",
          amount: 100000,
          description: "Initial funding into main bank account",
        },
        {
          account_id: equityAccountId,
          debit_or_credit: "credit",
          amount: 100000,
          description: "Initial owner funding",
        },
      ],
    };

    const response = await axios.post(`${booksBaseUrl}/journals`, payload, {
      params: {
        organization_id: organizationId,
      },
      headers: {
        Authorization: `Zoho-oauthtoken ${tokenData.access_token}`,
      },
    });

    res.json(response.data);
  } catch (error) {
    const details = error.response?.data || error.message;
    res.status(500).json(details);
  }
});

app.get("/zoho/monthly-value", async (req, res) => {
  const accountName = req.query.account_name;
  const period = req.query.period;

  if (!accountName || !period) {
    res.status(400).json({
      error: "Provide account_name and period query parameters, e.g. period=2026-01",
    });
    return;
  }

  const periodPattern = /^\d{4}-\d{2}$/;
  if (!periodPattern.test(period)) {
    res.status(400).json({
      error: "Period must be in YYYY-MM format.",
    });
    return;
  }

  try {
    const tokenData = await getAccessToken();
    const organizationId = await getDefaultOrganizationId(tokenData.access_token);
    const journalHeaders = await fetchAllJournals(tokenData.access_token, organizationId);
    const targetHeaders = journalHeaders.filter((journal) =>
      journal.journal_date?.startsWith(period)
    );
    const journals = await Promise.all(
      targetHeaders.map((journal) =>
        fetchJournalDetails(tokenData.access_token, organizationId, journal.journal_id)
      )
    );

    const matchingLineItems = journals
      .flatMap((journal) =>
        (journal.line_items || [])
          .filter((lineItem) => lineItem.account_name === accountName)
          .map((lineItem) => ({
            journal_date: journal.journal_date,
            reference_number: journal.reference_number,
            debit_or_credit: lineItem.debit_or_credit,
            amount: Number(lineItem.amount || 0),
            description: lineItem.description || "",
          }))
      );

    const total = matchingLineItems.reduce((sum, lineItem) => {
      const sign = lineItem.debit_or_credit === "debit" ? 1 : -1;
      return sum + sign * lineItem.amount;
    }, 0);

    res.json({
      organization_id: organizationId,
      account_name: accountName,
      period,
      value: total,
      entries: matchingLineItems,
    });
  } catch (error) {
    const details = error.response?.data || error.message;
    res.status(500).json(details);
  }
});

app.get("/zoho/refresh", async (_req, res) => {
  try {
    const tokenData = await getAccessToken();
    const organizationId = await getDefaultOrganizationId(tokenData.access_token);
    const accounts = await fetchChartOfAccounts(tokenData.access_token, organizationId);
    const accountRows = normalizeAccounts(accounts);
    const journalHeaders = await fetchAllJournals(tokenData.access_token, organizationId);
    const journals = await Promise.all(
      journalHeaders.map((journal) =>
        fetchJournalDetails(tokenData.access_token, organizationId, journal.journal_id)
      )
    );

    const lineRows = normalizeJournalLines(journals);
    const refreshedAt = new Date().toISOString();
    const periods = buildPeriodRange([...new Set(lineRows.map((row) => row.period))].sort());
    const periodRows = buildAccountPeriodRows(accountRows, lineRows, periods, refreshedAt);
    const summary = {
      organization_id: organizationId,
      account_dim_count: accountRows.length,
      journal_count: journals.length,
      journal_line_count: lineRows.length,
      account_period_count: periodRows.length,
      periods,
      account_count: accountRows.length,
    };

    refreshCache(accountRows, lineRows, periodRows, refreshedAt, summary);

    res.json({
      refreshed_at: refreshedAt,
      db_path: dbPath,
      ...summary,
    });
  } catch (error) {
    const details = error.response?.data || error.message;
    res.status(500).json(details);
  }
});

app.get("/cache/status", (_req, res) => {
  try {
    res.json(getCacheStatus());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/value", (req, res) => {
  const accountName = req.query.account_name;
  const period = req.query.period;

  if (!accountName || !period) {
    res.status(400).json({
      error: "Provide account_name and period query parameters, e.g. period=2026-01",
    });
    return;
  }

  const cachedValue = getAccountPeriodValue(accountName, period);
  const entries = getCachedEntries(accountName, period);
  const cacheStatus = getCacheStatus();

  if (!cachedValue) {
    res.status(404).json({
      account_name: accountName,
      period,
      value: 0,
      found: false,
      last_refresh_at: cacheStatus.last_refresh_at,
      message: "No cached value found. Run /zoho/refresh first or check account/period.",
    });
    return;
  }

  res.json({
    account_name: accountName,
    account_type: cachedValue.account_type,
    statement_type: cachedValue.statement_type,
    period,
    value:
      cachedValue.statement_type === "balance_sheet"
        ? cachedValue.month_end_balance
        : cachedValue.monthly_movement,
    value_basis:
      cachedValue.statement_type === "balance_sheet"
        ? "month_end_balance"
        : "monthly_movement",
    monthly_movement: cachedValue.monthly_movement,
    month_end_balance: cachedValue.month_end_balance,
    entry_count: cachedValue.entry_count,
    refreshed_at: cachedValue.refreshed_at,
    found: true,
    entries,
  });
});

app.listen(port, () => {
  console.log(`Zoho local prototype listening on http://localhost:${port}`);
});
