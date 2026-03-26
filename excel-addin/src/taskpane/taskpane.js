/* global document, Excel, Office, fetch, window */
/* eslint-disable office-addins/no-context-sync-in-loop */
/* eslint-disable office-addins/load-object-before-read */

const LOCAL_API_BASE_URL = "http://localhost:3000";
const ACC_FORMULA_PREFIX = "=ACC_VAL(";

function setStatus(message, isError = false) {
  const status = document.getElementById("status-text");
  status.textContent = message;
  status.style.color = isError ? "#a61b1b" : "#5a554f";
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

async function refreshStatus() {
  try {
    const status = await fetchJson(`${LOCAL_API_BASE_URL}/cache/status`);
    const container = document.getElementById("cache-status");
    container.innerHTML = `
      <div><strong>Last Sync:</strong> ${status.last_refresh_at || "Not synced yet"}</div>
      <div><strong>Accounts:</strong> ${status.account_dim_count || 0}</div>
      <div><strong>Journal Lines:</strong> ${status.journal_line_count || 0}</div>
      <div><strong>Account Periods:</strong> ${status.account_period_count || 0}</div>
    `;
  } catch (error) {
    document.getElementById("cache-status").textContent = error.message;
  }
}

function openZohoConnect() {
  window.open(`${LOCAL_API_BASE_URL}/connect/zoho`, "_blank");
  setStatus("Zoho connect flow opened in browser.");
}

async function syncAccountingData() {
  try {
    setStatus("Syncing accounting data...");
    const result = await fetchJson(`${LOCAL_API_BASE_URL}/zoho/refresh`);

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
            if (
              typeof formula === "string" &&
              formula.toUpperCase().startsWith(ACC_FORMULA_PREFIX)
            ) {
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

    const valueFont = document.getElementById("value-font").value;
    const valueColor = normalizeHexColor(document.getElementById("value-color").value);
    const valueSize = Number(document.getElementById("value-size").value);

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
          } else {
            cell.format.font.name = valueFont;
            cell.format.font.color = valueColor;
            cell.format.font.size = valueSize;
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

Office.onReady(() => {
  document.getElementById("sideload-msg").style.display = "none";
  document.getElementById("app-body").style.display = "flex";

  document.getElementById("connect-zoho").onclick = openZohoConnect;
  document.getElementById("sync-data").onclick = syncAccountingData;
  document.getElementById("replace-values").onclick = replaceAccValWithValues;
  document.getElementById("apply-formatting").onclick = applyFormattingToSelection;

  refreshStatus();
});
