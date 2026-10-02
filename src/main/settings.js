// Persistent settings + interview profile, stored in the app's userData folder.
// API keys are encrypted with the OS keychain (Electron safeStorage) when available.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const SECRET_KEYS = ['openaiKey', 'assemblyaiKey'];

const DEFAULTS = {
  // Providers
  transcriptionProvider: 'assemblyai', // 'assemblyai' | 'openai'
  openaiTranscribeModel: 'gpt-live-transcribe',
  assemblyaiSpeechModel: '', // empty = AssemblyAI default model
  diarize: true, // AssemblyAI: tell different voices apart within each audio source
  researchModel: 'gpt-5.4-mini',
  liveModel: 'gpt-5.4-mini',
  reasoningEffort: 'low', // '' to omit for non-reasoning models
  // Audio
  micDeviceId: 'default',
  interviewerSource: 'system', // 'system' (loopback) | an audio input deviceId (e.g. BlackHole / VB-Cable)
  vadThreshold: 0.012, // used by the OpenAI provider's client-side turn detection
  silenceMs: 800,
  // Overlay
  hideFromScreenShare: true,
  showTranscript: true,
  glassOpacity: 0.55,
  // Secrets (stored encrypted)
  openaiKey: '',
  assemblyaiKey: ''
};

const DEFAULT_PROFILE = {
  interviewerName: '',
  interviewerRole: '',
  interviewerLinkedin: '',
  company: '',
  companyUrl: '',
  jobTitle: '',
  jobDescription: '',
  myBackground: ''
};

function file(name) {
  return path.join(app.getPath('userData'), name);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, data) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(file(name), JSON.stringify(data, null, 2));
}

function encrypt(value) {
  if (!value) return '';
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(value).toString('base64');
  }
  return 'raw:' + Buffer.from(value, 'utf8').toString('base64');
}

function decrypt(value) {
  if (!value) return '';
  try {
    if (value.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    if (value.startsWith('raw:')) return Buffer.from(value.slice(4), 'base64').toString('utf8');
  } catch {
    return '';
  }
  return value;
}

let cache = null;

function load() {
  if (cache) return cache;
  const stored = readJson('settings.json', {});
  cache = { ...DEFAULTS, ...stored };
  for (const k of SECRET_KEYS) cache[k] = decrypt(stored[k]);
  // Environment variables override (handy for development)
  if (process.env.OPENAI_API_KEY && !cache.openaiKey) cache.openaiKey = process.env.OPENAI_API_KEY;
  if (process.env.ASSEMBLYAI_API_KEY && !cache.assemblyaiKey) cache.assemblyaiKey = process.env.ASSEMBLYAI_API_KEY;
  return cache;
}

function save(partial) {
  const current = load();
  const next = { ...current };
  for (const [k, v] of Object.entries(partial || {})) {
    if (!(k in DEFAULTS)) continue;
    // Empty secret field from the UI means "keep the existing key"
    if (SECRET_KEYS.includes(k) && (v === undefined || v === null || v === '')) continue;
    next[k] = v;
  }
  cache = next;
  const toDisk = { ...next };
  for (const k of SECRET_KEYS) toDisk[k] = encrypt(next[k]);
  writeJson('settings.json', toDisk);
  return publicView();
}

function clearSecret(key) {
  if (!SECRET_KEYS.includes(key)) return publicView();
  const current = load();
  current[key] = '';
  const toDisk = { ...current };
  for (const k of SECRET_KEYS) toDisk[k] = encrypt(current[k]);
  writeJson('settings.json', toDisk);
  return publicView();
}

// What the UI may see: never the raw keys.
function publicView() {
  const s = load();
  const view = { ...s };
  for (const k of SECRET_KEYS) {
    view[k] = '';
    view[k + 'Set'] = !!s[k];
    view[k + 'Hint'] = s[k] ? '••••' + s[k].slice(-4) : '';
  }
  return view;
}

function loadProfile() {
  return { ...DEFAULT_PROFILE, ...readJson('profile.json', {}) };
}

function saveProfile(p) {
  const next = { ...loadProfile() };
  for (const k of Object.keys(DEFAULT_PROFILE)) if (p && typeof p[k] === 'string') next[k] = p[k];
  writeJson('profile.json', next);
  return next;
}

function loadResearch() {
  return readJson('research.json', null);
}

function saveResearch(r) {
  writeJson('research.json', r);
}

module.exports = { load, save, clearSecret, publicView, loadProfile, saveProfile, loadResearch, saveResearch };
