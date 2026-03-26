/* global fetch */

const LOCAL_API_BASE_URL = "http://localhost:3000";

async function fetchJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) {
      return { value: 0, found: false };
    }

    let message = `${response.status} ${response.statusText}`;
    try {
      const errorJson = await response.json();
      message = errorJson.message || errorJson.error || message;
    } catch {
      // Ignore JSON parse failures and keep the HTTP status text.
    }

    throw new Error(message);
  }

  return response.json();
}

/**
 * Returns a cached accounting value for the given account and month.
 * P&L accounts return monthly movement. Balance sheet accounts return month-end balance.
 * @customfunction ACC_VAL
 * @param {string} accountName Exact Zoho account name
 * @param {string} period Accounting period in YYYY-MM format
 * @returns {Promise<number>} Cached accounting value
 */
export async function accVal(accountName, period) {
  const account = String(accountName || "").trim();
  const month = String(period || "").trim();

  if (!account || !month) {
    throw new Error("ACC_VAL requires account name and YYYY-MM period.");
  }

  const periodPattern = /^\d{4}-\d{2}$/;
  if (!periodPattern.test(month)) {
    throw new Error("Period must be in YYYY-MM format.");
  }

  const url =
    `${LOCAL_API_BASE_URL}/value?account_name=${encodeURIComponent(account)}` +
    `&period=${encodeURIComponent(month)}`;

  const data = await fetchJson(url);
  return Number(data.value || 0);
}
