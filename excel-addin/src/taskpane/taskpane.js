/* global document, Excel, Office, OfficeRuntime, fetch, window */
/* eslint-disable office-addins/no-context-sync-in-loop */
/* eslint-disable office-addins/load-object-before-read */

const CLOUD_API_BASE_URL = "https://xf1-data-load-production.up.railway.app";
const CLOUD_IDENTITY_STORAGE_KEY = "xf1-cloud-identity";
const CLOUD_USER_ID_STORAGE_KEY = "xf1-cloud-user-id";

function isAccValFormula(formula) {
  if (typeof formula !== "string") {
    return false;
  }

  const normalized = formula.trim().toUpperCase();
  return normalized.startsWith("=XF1.ACC_VAL(") || normalized.startsWith("=ACC_VAL(");
}

function setStatus(message, isError = false) {
  const status = document.getElementById("status-text");
  status.textContent = message;
  status.style.color = isError ? "#a61b1b" : "#5a554f";
}

async function persistCloudIdentity(identity) {
  window.localStorage.setItem(CLOUD_IDENTITY_STORAGE_KEY, JSON.stringify(identity));

  if (typeof OfficeRuntime !== "undefined" && OfficeRuntime.storage?.setItem) {
    await OfficeRuntime.storage.setItem(CLOUD_USER_ID_STORAGE_KEY, identity.email);
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  const contentType = response.headers.get("content-type") || "";

  if (!response.ok) {
    if (contentType.includes("application/json")) {
      const errorJson = await response.json();
      throw new Error(errorJson.message || errorJson.error || `${response.status}`);
    }

    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json();
}

function normalizeHexColor(value) {
  const trimmed = String(value || "").trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  throw new Error(`Invalid hex color: ${value}`);
}

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function getCloudIdentityFromInputs() {
  return {
    name: String(document.getElementById("cloud-name").value || "").trim(),
    email: normalizeEmail(document.getElementById("cloud-email").value),
  };
}

function getCloudIdentity() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CLOUD_IDENTITY_STORAGE_KEY) || "{}");
    return {
      name: String(parsed.name || "").trim(),
      email: normalizeEmail(parsed.email),
    };
  } catch {
    return { name: "", email: "" };
  }
}

function setCloudIdentityInputs(identity) {
  document.getElementById("cloud-name").value = identity.name || "";
  document.getElementById("cloud-email").value = identity.email || "";
}

async function saveCloudIdentity() {
  const identity = getCloudIdentityFromInputs();
  if (!identity.email) {
    throw new Error("Enter your email before saving cloud identity.");
  }

  await persistCloudIdentity(identity);
  return identity;
}

async function refreshCloudStatus() {
  const identity = getCloudIdentity();
  const container = document.getElementById("cloud-status");

  if (!identity.email) {
    container.innerHTML =
      "<div><strong>Cloud Zoho:</strong> Save your email to enable cloud connection.</div>";
    return;
  }

  try {
    const encodedUserId = encodeURIComponent(identity.email);
    const result = await fetchJson(`${CLOUD_API_BASE_URL}/users/${encodedUserId}/connections`);
    const latest = result.connections[0];

    if (!latest) {
      container.innerHTML = `
        <div><strong>User:</strong> ${identity.email}</div>
        <div><strong>Cloud Zoho:</strong> Not connected yet</div>
      `;
      return;
    }

    container.innerHTML = `
      <div><strong>User:</strong> ${identity.email}</div>
      <div><strong>Organization:</strong> ${latest.zoho_organization_name || "Unknown"}</div>
      <div><strong>Status:</strong> ${latest.status || "unknown"}</div>
      <div><strong>Updated:</strong> ${latest.updated_at || "Unknown"}</div>
    `;
  } catch (error) {
    container.textContent = error.message;
  }
}

async function refreshSyncStatus() {
  const identity = getCloudIdentity();
  const container = document.getElementById("cache-status");

  if (!identity.email) {
    container.innerHTML =
      "<div><strong>Sync:</strong> Save your email to load cloud sync status.</div>";
    return;
  }

  try {
    const encodedUserId = encodeURIComponent(identity.email);
    const status = await fetchJson(`${CLOUD_API_BASE_URL}/users/${encodedUserId}/cache-status`);
    container.innerHTML = `
      <div><strong>Connected Org:</strong> ${status.organization_name || "Not connected yet"}</div>
      <div><strong>Last Sync:</strong> ${status.last_refresh_at || "Not synced yet"}</div>
      <div><strong>Accounts:</strong> ${status.account_dim_count || 0}</div>
      <div><strong>Journal Lines:</strong> ${status.journal_line_count || 0}</div>
      <div><strong>Account Periods:</strong> ${status.account_period_count || 0}</div>
    `;
  } catch (error) {
    container.textContent = error.message;
  }
}

async function refreshStatus() {
  await Promise.all([refreshCloudStatus(), refreshSyncStatus()]);
}

async function openZohoConnect() {
  try {
    const identity = await saveCloudIdentity();
    const url =
      `${CLOUD_API_BASE_URL}/auth/zoho/start?user_id=${encodeURIComponent(identity.email)}` +
      `&email=${encodeURIComponent(identity.email)}` +
      `&name=${encodeURIComponent(identity.name || identity.email)}`;

    window.open(url, "_blank");
    setStatus("Cloud Zoho connect flow opened in browser.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function syncAccountingData() {
  try {
    const identity = await saveCloudIdentity();
    setStatus("Syncing accounting data...");
    const encodedUserId = encodeURIComponent(identity.email);
    const result = await fetchJson(`${CLOUD_API_BASE_URL}/users/${encodedUserId}/sync`);

    await Excel.run(async (context) => {
      context.workbook.application.calculate(Excel.CalculationType.full);
      await context.sync();
    });

    setStatus(`Synced ${result.journal_count} journals across ${result.periods.length} period(s).`);
    await refreshStatus();
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function replaceAccValWithValues() {
  try {
    setStatus("Replacing ACC_VAL formulas with values...");

    await Excel.run(async (context) => {
      const sheets = context.workbook.worksheets;
      sheets.load("items/name");
      await context.sync();

      for (const sheet of sheets.items) {
        const usedRange = sheet.getUsedRangeOrNullObject(true);
        usedRange.load(["formulas", "values", "rowCount", "columnCount"]);
        await context.sync();

        if (usedRange.isNullObject) {
          continue;
        }

        const formulas = usedRange.formulas;
        const values = usedRange.values;

        for (let row = 0; row < usedRange.rowCount; row += 1) {
          for (let col = 0; col < usedRange.columnCount; col += 1) {
            const formula = formulas[row][col];
            if (isAccValFormula(formula)) {
              const cell = usedRange.getCell(row, col);
              cell.values = [[values[row][col]]];
            }
          }
        }
      }

      await context.sync();
    });

    setStatus("ACC_VAL formulas replaced with values.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function applyFormattingToSelection() {
  try {
    const formulaFont = document.getElementById("formula-font").value;
    const formulaColor = normalizeHexColor(document.getElementById("formula-color").value);
    const formulaSize = Number(document.getElementById("formula-size").value);
    const formulaFormat = document.getElementById("formula-format").value.trim();

    const valueFont = document.getElementById("value-font").value;
    const valueColor = normalizeHexColor(document.getElementById("value-color").value);
    const valueSize = Number(document.getElementById("value-size").value);
    const valueFormat = document.getElementById("value-format").value.trim();

    await Excel.run(async (context) => {
      const range = context.workbook.getSelectedRange();
      range.load(["formulas", "values", "rowCount", "columnCount"]);
      await context.sync();

      for (let row = 0; row < range.rowCount; row += 1) {
        for (let col = 0; col < range.columnCount; col += 1) {
          const cell = range.getCell(row, col);
          const formula = range.formulas[row][col];
          const rawValue = range.values[row][col];
          const hasFormula = typeof formula === "string" && formula.startsWith("=");
          const isBlank = rawValue === null || rawValue === "" || typeof rawValue === "undefined";

          if (isBlank) {
            continue;
          }

          if (hasFormula) {
            cell.format.font.name = formulaFont;
            cell.format.font.color = formulaColor;
            cell.format.font.size = formulaSize;
            if (formulaFormat) {
              cell.numberFormat = [[formulaFormat]];
            }
          } else {
            cell.format.font.name = valueFont;
            cell.format.font.color = valueColor;
            cell.format.font.size = valueSize;
            if (valueFormat) {
              cell.numberFormat = [[valueFormat]];
            }
          }
        }
      }

      await context.sync();
    });

    setStatus("Formatting applied to selection.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

function handleSaveIdentity() {
  saveCloudIdentity()
    .then(() => {
      setStatus("Cloud identity saved.");
      return refreshStatus();
    })
    .catch((error) => {
      setStatus(error.message, true);
    });
}

Office.onReady(() => {
  document.getElementById("sideload-msg").style.display = "none";
  document.getElementById("app-body").style.display = "flex";

  setCloudIdentityInputs(getCloudIdentity());

  document.getElementById("save-identity").onclick = handleSaveIdentity;
  document.getElementById("connect-zoho").onclick = openZohoConnect;
  document.getElementById("sync-data").onclick = syncAccountingData;
  document.getElementById("replace-values").onclick = replaceAccValWithValues;
  document.getElementById("apply-formatting").onclick = applyFormattingToSelection;

  refreshStatus();
});
