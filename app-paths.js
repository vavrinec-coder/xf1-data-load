const fs = require("fs");
const os = require("os");
const path = require("path");

function trimValue(value) {
  return String(value || "").trim();
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

const configuredHome = trimValue(process.env.XF1_DATA_LOAD_HOME);
const appHome =
  configuredHome ||
  path.join(trimValue(process.env.LOCALAPPDATA) || path.join(os.homedir(), "AppData", "Local"), "XF1 Data Load");

const dataDir = ensureDirectory(path.join(appHome, "data"));
const logsDir = ensureDirectory(path.join(appHome, "logs"));
const runtimeDir = ensureDirectory(path.join(appHome, "runtime"));

const dbPath = path.join(dataDir, "zoho-cache.sqlite");
const tokenFilePath = path.join(dataDir, "zoho-tokens.json");
const pidFilePath = path.join(runtimeDir, "xf1-companion.pid");

module.exports = {
  appHome,
  dataDir,
  logsDir,
  runtimeDir,
  dbPath,
  tokenFilePath,
  pidFilePath,
};
