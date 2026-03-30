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
  updateZohoConnectionTokens,
  getConnectionsForUser,
  getPrimaryConnectionForUser,
  replaceUserOrgCache,
  getCacheStatus,
  getAccountPeriodValue,
  getDepartmentAccountPeriodValue,
  dbHealth,
  exportUserOrgRows,
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
const sessionSecret = process.env.SESSION_SECRET;
const pilotDepartmentTag = {
  tag_id: "3538165000000000632",
  tag_name: "Department",
  sales_option_id: "3538165000000064044",
  operations_option_id: "3538165000000064042",
};

if (!publicBaseUrl || !clientId || !clientSecret || !redirectUri || !accountsBaseUrl || !booksBaseUrl) {
  throw new Error("Missing required cloud backend environment variables.");
}

app.use(express.json());
app.use(
  cors({
    origin: true,
  })
);

function getStatementType(accountType) {
  const normalized = String(accountType || "").trim().toLowerCase();
  const pnlTypes = new Set(["income", "other_income", "expense", "other_expense", "cost_of_goods_sold"]);

  return pnlTypes.has(normalized) ? "p_and_l" : "balance_sheet";
}

function isAssetLikeAccountType(accountType) {
  const normalized = String(accountType || "").trim().toLowerCase();
  const assetTypes = new Set([
    "accounts_receivable",
    "cash",
    "expense",
    "fixed_asset",
    "other_expense",
    "other_current_asset",
    "stock",
    "cost_of_goods_sold",
  ]);

  return assetTypes.has(normalized);
}

function toDisplayValue(rawValue, accountType) {
  const numeric = Number(rawValue || 0);
  return isAssetLikeAccountType(accountType) ? numeric : -numeric;
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

function toCsv(rows) {
  if (!rows.length) {
    return "";
  }

  const headers = Object.keys(rows[0]);
  const escapeCell = (value) => {
    const text = value == null ? "" : String(value);
    if (/[",\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };

  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => escapeCell(row[header])).join(",")),
  ];

  return `${lines.join("\n")}\n`;
}

function chunk(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
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

function getDepartmentTag(tags = []) {
  return (tags || []).find((tag) => String(tag.tag_name || "").trim().toLowerCase() === "department");
}

function normalizePostingLineFacts(accountRows, journals) {
  const accountMap = new Map(accountRows.map((account) => [account.account_id, account]));

  return journals.flatMap((journal) =>
    (journal.line_items || []).map((lineItem) => {
      const account = accountMap.get(lineItem.account_id) || {};
      const amount = Number(lineItem.amount || 0);
      const signedAmountRaw = lineItem.debit_or_credit === "debit" ? amount : -amount;
      const departmentTag = getDepartmentTag(lineItem.tags);

      return {
        source_module: "journal",
        source_txn_id: journal.journal_id,
        source_line_id: lineItem.line_id,
        posting_date: journal.journal_date,
        period: journal.journal_date.slice(0, 7),
        account_id: lineItem.account_id || "",
        account_name: lineItem.account_name || account.account_name || "",
        account_type: account.account_type || "",
        statement_type: account.statement_type || getStatementType(account.account_type),
        debit_or_credit: lineItem.debit_or_credit,
        amount,
        signed_amount_raw: Number(signedAmountRaw.toFixed(2)),
        reference_number: journal.reference_number || "",
        description: lineItem.description || journal.notes || "",
        department_tag_id: departmentTag?.tag_option_id || null,
        department_name: departmentTag?.tag_option_name || null,
      };
    })
  );
}

function normalizeInvoicePostingLineFacts(accountRows, itemRows, invoices) {
  const accountMap = new Map(accountRows.map((account) => [account.account_id, account]));
  const itemMap = new Map(itemRows.map((item) => [item.item_id, item]));

  return invoices.flatMap((invoice) =>
    (invoice.line_items || []).flatMap((lineItem) => {
      const departmentTag = getDepartmentTag(lineItem.tags);
      if (!departmentTag) {
        return [];
      }

      const item = itemMap.get(lineItem.item_id) || {};
      const accountId = lineItem.account_id || item.account_id || item.sales_account_id || "";
      const account = accountMap.get(accountId) || {};
      const amountRaw = Number(
        lineItem.item_total ||
          lineItem.item_sub_total ||
          lineItem.amount ||
          Number(lineItem.rate || 0) * Number(lineItem.quantity || 0)
      );
      const amount = Number.isFinite(amountRaw) ? amountRaw : 0;

      return [
        {
          source_module: "invoice",
          source_txn_id: invoice.invoice_id,
          source_line_id: lineItem.line_item_id || `${invoice.invoice_id}::${lineItem.item_id || "unknown-item"}`,
          posting_date: invoice.date,
          period: String(invoice.date || "").slice(0, 7),
          account_id: accountId,
          account_name: lineItem.account_name || account.account_name || item.account_name || "",
          account_type: account.account_type || "",
          statement_type: account.statement_type || getStatementType(account.account_type),
          debit_or_credit: "credit",
          amount: Number(amount.toFixed(2)),
          signed_amount_raw: Number((-amount).toFixed(2)),
          reference_number: invoice.invoice_number || "",
          description: lineItem.description || invoice.notes || "",
          department_tag_id: departmentTag.tag_option_id || null,
          department_name: departmentTag.tag_option_name || null,
        },
      ];
    })
  );
}

function buildAccountPeriodDepartmentRows(accountRows, postingLineRows, periods, refreshedAt) {
  const movementMap = new Map();
  const accountDepartmentMap = new Map();

  for (const row of postingLineRows) {
    if (!row.account_id || !row.period || !row.department_name) {
      continue;
    }

    const key = `${row.account_id}::${row.period}::${row.department_name}`;
    const existing = movementMap.get(key) || {
      monthly_movement_raw: 0,
      entry_count: 0,
      department_tag_id: row.department_tag_id || null,
      department_name: row.department_name,
    };

    existing.monthly_movement_raw += row.signed_amount_raw;
    existing.entry_count += 1;
    movementMap.set(key, existing);

    const accountDepartmentKey = `${row.account_id}::${row.department_name}`;
    if (!accountDepartmentMap.has(accountDepartmentKey)) {
      accountDepartmentMap.set(accountDepartmentKey, {
        account_id: row.account_id,
        department_tag_id: row.department_tag_id || null,
        department_name: row.department_name,
      });
    }
  }

  const accountMap = new Map(accountRows.map((account) => [account.account_id, account]));

  return [...accountDepartmentMap.values()].flatMap((accountDepartment) => {
    const account = accountMap.get(accountDepartment.account_id);
    if (!account) {
      return [];
    }

    let closingBalanceRaw = 0;

    return periods.map((period) => {
      const movement = movementMap.get(
        `${accountDepartment.account_id}::${period}::${accountDepartment.department_name}`
      ) || {
        monthly_movement_raw: 0,
        entry_count: 0,
        department_tag_id: accountDepartment.department_tag_id,
        department_name: accountDepartment.department_name,
      };

      if (account.statement_type === "balance_sheet") {
        closingBalanceRaw += movement.monthly_movement_raw;
      }

      return {
        account_id: account.account_id,
        account_name: account.account_name,
        account_type: account.account_type,
        statement_type: account.statement_type,
        period,
        department_tag_id: movement.department_tag_id,
        department_name: movement.department_name,
        monthly_movement_raw: Number(movement.monthly_movement_raw.toFixed(2)),
        month_end_balance_raw:
          account.statement_type === "balance_sheet" ? Number(closingBalanceRaw.toFixed(2)) : null,
        entry_count: movement.entry_count,
        refreshed_at: refreshedAt,
      };
    });
  });
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
          account.statement_type === "balance_sheet" ? Number(closingBalance.toFixed(2)) : null,
        entry_count: movement.entry_count,
        refreshed_at: refreshedAt,
      };
    });
  });
}

async function getOrganizations(accessToken, targetBooksBaseUrl = booksBaseUrl) {
  const response = await axios.get(`${targetBooksBaseUrl}/organizations`, {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
  });

  return response.data.organizations || [];
}

async function fetchChartOfAccounts(accessToken, organizationId, targetBooksBaseUrl) {
  const response = await axios.get(`${targetBooksBaseUrl}/chartofaccounts`, {
    params: {
      organization_id: organizationId,
    },
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
  });

  return response.data.chartofaccounts || [];
}

async function fetchAllJournals(accessToken, organizationId, targetBooksBaseUrl) {
  const allJournals = [];
  let page = 1;
  const perPage = 200;

  while (true) {
    const response = await axios.get(`${targetBooksBaseUrl}/journals`, {
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

async function fetchAllInvoices(accessToken, organizationId, targetBooksBaseUrl) {
  const allInvoices = [];
  let page = 1;
  const perPage = 200;

  while (true) {
    const response = await axios.get(`${targetBooksBaseUrl}/invoices`, {
      params: {
        organization_id: organizationId,
        page,
        per_page: perPage,
      },
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
      },
    });

    const invoices = response.data.invoices || [];
    allInvoices.push(...invoices);

    if (invoices.length < perPage) {
      break;
    }

    page += 1;
  }

  return allInvoices;
}

async function fetchInvoiceDetails(accessToken, organizationId, invoiceId, targetBooksBaseUrl) {
  const response = await axios.get(`${targetBooksBaseUrl}/invoices/${invoiceId}`, {
    params: {
      organization_id: organizationId,
    },
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
  });

  return response.data.invoice;
}

async function fetchAllItems(accessToken, organizationId, targetBooksBaseUrl) {
  const allItems = [];
  let page = 1;
  const perPage = 200;

  while (true) {
    const response = await axios.get(`${targetBooksBaseUrl}/items`, {
      params: {
        organization_id: organizationId,
        page,
        per_page: perPage,
      },
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
      },
    });

    const items = response.data.items || [];
    allItems.push(...items);

    if (items.length < perPage) {
      break;
    }

    page += 1;
  }

  return allItems;
}

async function fetchJournalDetails(accessToken, organizationId, journalId, targetBooksBaseUrl) {
  const response = await axios.get(`${targetBooksBaseUrl}/journals/${journalId}`, {
    params: {
      organization_id: organizationId,
    },
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
  });

  return response.data.journal;
}

async function fetchAccountTransactions(accessToken, organizationId, accountId, targetBooksBaseUrl) {
  const allTransactions = [];
  let page = 1;
  const perPage = 200;

  while (true) {
    const response = await axios.get(`${targetBooksBaseUrl}/chartofaccounts/transactions`, {
      params: {
        organization_id: organizationId,
        account_id: accountId,
        page,
        per_page: perPage,
      },
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
      },
    });

    const transactions = response.data.transactions || [];
    allTransactions.push(...transactions);

    if (transactions.length < perPage) {
      break;
    }

    page += 1;
  }

  return allTransactions;
}

function normalizeAccountTransactions(accountRows, transactionRows) {
  const accountMap = new Map(accountRows.map((account) => [account.account_id, account]));

  return transactionRows.map((transaction, index) => {
    const account = accountMap.get(transaction.account_id) || {};
    const debitAmount = Number(transaction.debit_amount || 0);
    const creditAmount = Number(transaction.credit_amount || 0);
    const signedAmount = debitAmount - creditAmount;
    const transactionDate = transaction.transaction_date || "";

    return {
      line_id:
        transaction.categorized_transaction_id ||
        `${transaction.account_id || "unknown-account"}::${transaction.transaction_id || "unknown-tx"}::${index}`,
      journal_id: transaction.transaction_id || transaction.categorized_transaction_id || `tx-${index}`,
      journal_date: transactionDate,
      period: transactionDate.slice(0, 7),
      reference_number: transaction.reference_number || transaction.entry_number || "",
      account_id: transaction.account_id || account.account_id || "",
      account_name: transaction.account_name || account.account_name || "",
      debit_or_credit: signedAmount >= 0 ? "debit" : "credit",
      amount: Number(Math.abs(signedAmount).toFixed(2)),
      signed_amount: Number(signedAmount.toFixed(2)),
      description: transaction.description || transaction.transaction_type || "",
    };
  });
}

async function getAuthenticatedConnection(userId) {
  const connection = await getPrimaryConnectionForUser(userId);
  if (!connection) {
    throw new Error("No Zoho connection found for this user.");
  }

  if (!connection.refresh_token && !connection.access_token) {
    throw new Error("Zoho connection has no usable token.");
  }

  if (connection.access_token) {
    try {
      await getOrganizations(connection.access_token, connection.zoho_books_base_url);
      return {
        ...connection,
        live_access_token: connection.access_token,
      };
    } catch (error) {
      const status = error?.response?.status;
      const code = error?.response?.data?.code;
      if (status !== 401 && code !== 57) {
        throw error;
      }
    }
  }

  if (!connection.refresh_token) {
    throw new Error("Zoho connection has no refresh token and stored access token is no longer valid.");
  }

  const tokenResponse = await axios.post(`${connection.zoho_accounts_base_url}/oauth/v2/token`, null, {
    params: {
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: connection.refresh_token,
    },
  });

  const accessToken = tokenResponse.data.access_token;
  await updateZohoConnectionTokens(connection.id, accessToken, tokenResponse.data.refresh_token || null);

  return {
    ...connection,
    live_access_token: accessToken,
  };
}

app.post("/internal/pilot/seed-adapter-test-data", async (req, res) => {
  try {
    const internalKey = String(req.query.key || req.body?.key || "").trim();
    const userId = String(req.query.user_id || req.body?.user_id || "").trim();

    if (!internalKey || (internalKey !== sessionSecret && internalKey !== clientSecret)) {
      res.status(403).json({ error: "Forbidden." });
      return;
    }

    if (!userId) {
      res.status(400).json({ error: "Provide user_id." });
      return;
    }

    const connection = await getAuthenticatedConnection(userId);
    const accessToken = connection.live_access_token;
    const organizationId = connection.zoho_organization_id;
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const headers = { Authorization: `Zoho-oauthtoken ${accessToken}` };

    const books = axios.create({
      baseURL: connection.zoho_books_base_url,
      headers,
    });

    const accounts = normalizeAccounts(
      await fetchChartOfAccounts(accessToken, organizationId, connection.zoho_books_base_url)
    );

    const salesAccount = accounts.find((account) => account.account_name === "Sales");
    const consultantAccount =
      accounts.find((account) => account.account_name === "Consultant Expense") ||
      accounts.find((account) => account.account_name === "Other Expenses");
    const cashAccount =
      accounts.find((account) => account.account_name === "Main Bank account") ||
      accounts.find((account) => account.account_type === "cash");

    if (!salesAccount || !consultantAccount || !cashAccount) {
      res.status(400).json({
        error: "Required accounts not found.",
        sales_account: salesAccount?.account_id || null,
        consultant_account: consultantAccount?.account_id || null,
        cash_account: cashAccount?.account_id || null,
      });
      return;
    }

    const tagResponse = await books.get("/reportingtags", {
      params: { organization_id: organizationId },
    });
    const reportingTags = tagResponse.data.reporting_tags || tagResponse.data.reportingtags || [];
    const departmentTag = reportingTags.find(
      (tag) => String(tag.tag_name || "").trim().toLowerCase() === "department"
    ) || {
      tag_id: pilotDepartmentTag.tag_id,
      tag_name: pilotDepartmentTag.tag_name,
    };

    const optionsResponse = await books.get("/reportingtags/options", {
      params: { organization_id: organizationId, tag_id: departmentTag.tag_id },
    });
    const departmentOptions = optionsResponse.data.tag_options || [];
    const salesDepartment =
      departmentOptions.find((option) => option.tag_option_name === "Sales") || {
        tag_option_id: pilotDepartmentTag.sales_option_id,
        tag_option_name: "Sales",
      };
    const operationsDepartment =
      departmentOptions.find((option) => option.tag_option_name === "Operations") || {
        tag_option_id: pilotDepartmentTag.operations_option_id,
        tag_option_name: "Operations",
      };

    const customerResponse = await books.post(`/contacts?organization_id=${organizationId}`, {
      contact_name: `XF1 Pilot Customer ${timestamp}`,
      company_name: `XF1 Pilot Customer ${timestamp}`,
      contact_type: "customer",
    });
    const customer = customerResponse.data.contact;

    const vendorResponse = await books.post(`/contacts?organization_id=${organizationId}`, {
      contact_name: `XF1 Pilot Vendor ${timestamp}`,
      company_name: `XF1 Pilot Vendor ${timestamp}`,
      contact_type: "vendor",
    });
    const vendor = vendorResponse.data.contact;

    const salesItemResponse = await books.post(`/items?organization_id=${organizationId}`, {
      name: `XF1 Pilot Service ${timestamp}`,
      rate: 12000,
      item_type: "sales",
      account_id: salesAccount.account_id,
      description: "Pilot sales adapter test item",
    });
    const salesItem = salesItemResponse.data.item;

    const invoiceResponse = await books.post(`/invoices?organization_id=${organizationId}`, {
      customer_id: customer.contact_id,
      date: "2026-03-29",
      line_items: [
        {
          item_id: salesItem.item_id,
          rate: 12000,
          quantity: 1,
          description: "Sales adapter tag test",
          tags: [{ tag_id: departmentTag.tag_id, tag_option_id: salesDepartment.tag_option_id }],
        },
      ],
      notes: "Pilot tagged sales invoice for adapter testing",
    });
    const invoice = invoiceResponse.data.invoice;

    let purchaseResult = null;
    let purchaseMode = null;

    try {
      const billResponse = await books.post(`/bills?organization_id=${organizationId}`, {
        vendor_id: vendor.contact_id,
        date: "2026-03-29",
        line_items: [
          {
            name: `XF1 Pilot Consultant Service ${timestamp}`,
            rate: 7000,
            quantity: 1,
            account_id: consultantAccount.account_id,
            description: "Purchase adapter tag test",
            tags: [{ tag_id: departmentTag.tag_id, tag_option_id: operationsDepartment.tag_option_id }],
          },
        ],
        notes: "Pilot tagged bill for adapter testing",
      });
      purchaseResult = billResponse.data.bill;
      purchaseMode = "bill";
    } catch (billError) {
      const expenseResponse = await books.post(`/expenses?organization_id=${organizationId}`, {
        account_id: consultantAccount.account_id,
        paid_through_account_id: cashAccount.account_id,
        date: "2026-03-29",
        amount: 7000,
        vendor_id: vendor.contact_id,
        description: "Pilot tagged expense for adapter testing",
        line_items: [
          {
            account_id: consultantAccount.account_id,
            amount: 7000,
            description: "Expense adapter tag test",
            tags: [{ tag_id: departmentTag.tag_id, tag_option_id: operationsDepartment.tag_option_id }],
          },
        ],
      });
      purchaseResult = expenseResponse.data.expense;
      purchaseMode = "expense";
    }

    res.json({
      ok: true,
      user_id: userId,
      organization_id: organizationId,
      tag_name: departmentTag.tag_name,
      sales_invoice: {
        invoice_id: invoice.invoice_id,
        invoice_number: invoice.invoice_number,
        customer_name: customer.contact_name,
      },
      purchase_transaction: {
        mode: purchaseMode,
        id:
          purchaseResult.bill_id ||
          purchaseResult.expense_id ||
          purchaseResult.purchaseorder_id ||
          null,
        number:
          purchaseResult.bill_number ||
          purchaseResult.expense_number ||
          purchaseResult.expense_reference_id ||
          null,
        vendor_name: vendor.contact_name,
      },
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      details: error.response?.data || null,
    });
  }
});

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

app.get("/users/:userId/cache-status", async (req, res) => {
  try {
    const userId = String(req.params.userId || "").trim();
    if (!userId) {
      res.status(400).json({ error: "Missing userId." });
      return;
    }

    const connection = await getPrimaryConnectionForUser(userId);
    if (!connection) {
      res.json({
        user_id: userId,
        connected: false,
        last_refresh_at: null,
        account_dim_count: 0,
        journal_line_count: 0,
        account_period_count: 0,
        posting_line_fact_count: 0,
        account_period_department_count: 0,
      });
      return;
    }

    const status = await getCacheStatus(userId, connection.zoho_organization_id);
    res.json({
      user_id: userId,
      connected: true,
      organization_id: connection.zoho_organization_id,
      organization_name: connection.zoho_organization_name,
      ...status,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/users/:userId/value", async (req, res) => {
  try {
    const userId = String(req.params.userId || "").trim();
    const accountName = String(req.query.account_name || "").trim();
    const period = String(req.query.period || "").trim();

    if (!userId || !accountName || !period) {
      res.status(400).json({ error: "Provide userId, account_name, and period." });
      return;
    }

    const connection = await getPrimaryConnectionForUser(userId);
    if (!connection) {
      res.status(404).json({ error: "No Zoho connection found for this user." });
      return;
    }

    const row = await getAccountPeriodValue(userId, connection.zoho_organization_id, accountName, period);
    if (!row) {
      res.status(404).json({
        user_id: userId,
        organization_id: connection.zoho_organization_id,
        account_name: accountName,
        period,
        value: 0,
        found: false,
      });
      return;
    }

      const rawValue =
        row.statement_type === "balance_sheet"
          ? Number(row.month_end_balance || 0)
          : Number(row.monthly_movement || 0);
      const value = toDisplayValue(rawValue, row.account_type);

      res.json({
        user_id: userId,
        organization_id: connection.zoho_organization_id,
        account_name: accountName,
        period,
        account_type: row.account_type,
        statement_type: row.statement_type,
        raw_value: rawValue,
        value,
        found: true,
        refreshed_at: row.refreshed_at,
      });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/users/:userId/value-by-department", async (req, res) => {
  try {
    const userId = String(req.params.userId || "").trim();
    const accountName = String(req.query.account_name || "").trim();
    const period = String(req.query.period || "").trim();
    const department = String(req.query.department || "").trim();

    if (!userId || !accountName || !period || !department) {
      res.status(400).json({ error: "Provide userId, account_name, period, and department." });
      return;
    }

    const connection = await getPrimaryConnectionForUser(userId);
    if (!connection) {
      res.status(404).json({ error: "No Zoho connection found for this user." });
      return;
    }

    const row = await getDepartmentAccountPeriodValue(
      userId,
      connection.zoho_organization_id,
      accountName,
      period,
      department
    );
    if (!row) {
      res.status(404).json({
        user_id: userId,
        organization_id: connection.zoho_organization_id,
        account_name: accountName,
        period,
        department,
        value: 0,
        found: false,
      });
      return;
    }

    const rawValue =
      row.statement_type === "balance_sheet"
        ? Number(row.month_end_balance_raw || 0)
        : Number(row.monthly_movement_raw || 0);
    const value = toDisplayValue(rawValue, row.account_type);

    res.json({
      user_id: userId,
      organization_id: connection.zoho_organization_id,
      account_name: accountName,
      period,
      department,
      account_type: row.account_type,
      statement_type: row.statement_type,
      raw_value: rawValue,
      value,
      found: true,
      refreshed_at: row.refreshed_at,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/users/:userId/export/:tableName.csv", async (req, res) => {
  try {
    const userId = String(req.params.userId || "").trim();
    const tableName = String(req.params.tableName || "").trim();

    if (!userId || !tableName) {
      res.status(400).json({ error: "Provide userId and tableName." });
      return;
    }

    const connection = await getPrimaryConnectionForUser(userId);
    if (!connection) {
      res.status(404).json({ error: "No Zoho connection found for this user." });
      return;
    }

    const rows = await exportUserOrgRows(userId, connection.zoho_organization_id, tableName);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${tableName}-${userId.replace(/[^a-zA-Z0-9._-]/g, "_")}.csv"`
    );
    res.send(toCsv(rows));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/users/:userId/sync", async (req, res) => {
  try {
    const userId = String(req.params.userId || "").trim();
    if (!userId) {
      res.status(400).json({ error: "Missing userId." });
      return;
    }

    const connection = await getAuthenticatedConnection(userId);
    const accessToken = connection.live_access_token;
    const organizationId = connection.zoho_organization_id;

    const accounts = await fetchChartOfAccounts(accessToken, organizationId, connection.zoho_books_base_url);
    const normalizedAccounts = normalizeAccounts(accounts);
    const transactionRows = [];
    const accountBatches = chunk(
      normalizedAccounts.filter((account) => account.account_id),
      5
    );

    for (const accountBatch of accountBatches) {
      const batchResults = await Promise.all(
        accountBatch.map((account) =>
          fetchAccountTransactions(
            accessToken,
            organizationId,
            account.account_id,
            connection.zoho_books_base_url
          )
        )
      );

      for (const accountTransactions of batchResults) {
        transactionRows.push(...accountTransactions);
      }
    }

    const lineRows = normalizeAccountTransactions(normalizedAccounts, transactionRows).filter(
      (row) => row.account_name && row.period
    );
    const distinctPeriods = [...new Set(lineRows.map((row) => row.period))].sort();
    const periodRange = buildPeriodRange(distinctPeriods);
    const journals = await fetchAllJournals(accessToken, organizationId, connection.zoho_books_base_url);
    const detailedJournals = [];
    const journalBatches = chunk(journals, 10);

    for (const journalBatch of journalBatches) {
      const details = await Promise.all(
        journalBatch.map((journal) =>
          fetchJournalDetails(
            accessToken,
            organizationId,
            journal.journal_id,
            connection.zoho_books_base_url
          )
        )
      );
      detailedJournals.push(...details);
    }

    const items = await fetchAllItems(accessToken, organizationId, connection.zoho_books_base_url);
    const invoices = await fetchAllInvoices(accessToken, organizationId, connection.zoho_books_base_url);
    const detailedInvoices = [];
    const invoiceBatches = chunk(invoices, 10);

    for (const invoiceBatch of invoiceBatches) {
      const details = await Promise.all(
        invoiceBatch.map((invoice) =>
          fetchInvoiceDetails(
            accessToken,
            organizationId,
            invoice.invoice_id,
            connection.zoho_books_base_url
          )
        )
      );
      detailedInvoices.push(...details);
    }

    const postingLineRows = [
      ...normalizePostingLineFacts(normalizedAccounts, detailedJournals),
      ...normalizeInvoicePostingLineFacts(normalizedAccounts, items, detailedInvoices),
    ].filter((row) => row.account_name && row.period && row.department_name);
    const refreshedAt = new Date().toISOString();
    const accountPeriodRows = buildAccountPeriodRows(normalizedAccounts, lineRows, periodRange, refreshedAt);
    const accountPeriodDepartmentRows = buildAccountPeriodDepartmentRows(
      normalizedAccounts,
      postingLineRows,
      periodRange,
      refreshedAt
    ).filter((row) => row.department_name);

    const summary = {
      organization_id: organizationId,
      organization_name: connection.zoho_organization_name,
      account_count: normalizedAccounts.length,
      journal_count: detailedJournals.length,
      transaction_count: transactionRows.length,
      line_count: lineRows.length,
      invoice_count: detailedInvoices.length,
      posting_line_fact_count: postingLineRows.length,
      account_period_department_count: accountPeriodDepartmentRows.length,
      periods: periodRange,
    };

    await replaceUserOrgCache({
      userId,
      organizationId,
      accountRows: normalizedAccounts,
      lineRows,
      periodRows: accountPeriodRows,
      postingLineRows,
      departmentPeriodRows: accountPeriodDepartmentRows,
      refreshedAt,
      summary,
    });

    res.json({
      user_id: userId,
      ...summary,
      refreshed_at: refreshedAt,
    });
  } catch (error) {
    const details = error.response?.data?.message || error.response?.data || error.message;
    res.status(500).json({ error: typeof details === "string" ? details : JSON.stringify(details) });
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
    const organizations = await getOrganizations(access_token, booksBaseUrl);
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
