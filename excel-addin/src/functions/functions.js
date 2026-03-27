/* global OfficeRuntime, fetch, localStorage */

const CLOUD_API_BASE_URL = "https://xf1-data-load-production.up.railway.app";
const CLOUD_IDENTITY_STORAGE_KEY = "xf1-cloud-identity";
const CLOUD_USER_ID_STORAGE_KEY = "xf1-cloud-user-id";

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

async function getCloudUserId() {
  if (typeof OfficeRuntime !== "undefined" && OfficeRuntime.storage?.getItem) {
    const storedUserId = await OfficeRuntime.storage.getItem(CLOUD_USER_ID_STORAGE_KEY);
    if (storedUserId) {
      return String(storedUserId).trim().toLowerCase();
    }
  }

  if (typeof localStorage !== "undefined") {
    try {
      const parsed = JSON.parse(localStorage.getItem(CLOUD_IDENTITY_STORAGE_KEY) || "{}");
      const email = String(parsed.email || "")
        .trim()
        .toLowerCase();
      if (email) {
        return email;
      }
    } catch {
      // Ignore local storage parse failures and continue to the error below.
    }
  }

  throw new Error("Save your Cloud Identity in the XF1 panel before using ACC_VAL.");
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

  const userId = await getCloudUserId();
  const url =
    `${CLOUD_API_BASE_URL}/users/${encodeURIComponent(userId)}/value?account_name=${encodeURIComponent(account)}` +
    `&period=${encodeURIComponent(month)}`;

  const data = await fetchJson(url);
  return Number(data.value || 0);
}
