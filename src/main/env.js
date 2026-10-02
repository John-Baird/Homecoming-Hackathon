// Minimal .env loader (no dependency). Reads KEY=value lines from the project's .env
// without overriding variables that are already set. Used by the app and test scripts.
const fs = require('fs');
const path = require('path');

function loadEnv(dir) {
  const file = path.join(dir, '.env');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
  return true;
}

module.exports = { loadEnv };
