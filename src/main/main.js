// Interview Copilot — Electron main process.
const { app, BrowserWindow, ipcMain, screen, globalShortcut, session, desktopCapturer, systemPreferences, shell } = require('electron');
const path = require('path');
require('./env').loadEnv(path.join(__dirname, '..', '..')); // dev convenience: keys from .env
const settings = require('./settings');
const ai = require('./ai');
const { createAssemblyAI } = require('./transcribe/assemblyai');
const { createOpenAI } = require('./transcribe/openai');
const { runDemo, DEMO_RESEARCH } = require('./demo');

const SMOKE = process.env.COPILOT_SMOKE || ''; // dev only: path to save an overlay screenshot, then quit
const { createSpeakerRegistry } = require('./speakers');
let stopDemo = null;

const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload.js');

let setupWin = null;
let overlayWin = null;

/* ---------------- Call session state ---------------- */
// Audio channels: "mic" = this computer's microphone, "call" = the call's audio output.

const CHANNELS = ['mic', 'call'];
const speakers = createSpeakerRegistry();

const state = {
  mode: process.argv.includes('--demo') || process.env.COPILOT_DEMO === '1' ? 'demo' : 'live',
  running: false,
  paused: false,
  turns: [], // { id, channel, speakerKey, text, at }
  partial: { mic: null, call: null }, // { speakerKey, text } | null
  status: { mic: 'idle', call: 'idle', ai: 'idle', message: '' },
  technical: [], // { id, question, answer, points, code, at, manual }
  social: { relevantIds: [], tip: '', at: 0 },
  research: null
};

let streams = { mic: null, call: null };
let turnSeq = 0;
let cardSeq = 0;

const isDemo = () => state.mode === 'demo';

function toOverlay(channel, payload) {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send(channel, payload);
}
function toSetup(channel, payload) {
  if (setupWin && !setupWin.isDestroyed()) setupWin.webContents.send(channel, payload);
}
function statusPayload() {
  return { ...state.status, running: state.running, paused: state.paused, mode: state.mode };
}
function pushStatus(patch) {
  Object.assign(state.status, patch);
  toOverlay('status', statusPayload());
  toSetup('session:status', statusPayload());
}
function pushSpeakers() {
  toOverlay('speakers', speakers.list());
}

function snapshot() {
  return {
    mode: state.mode,
    running: state.running,
    paused: state.paused,
    turns: state.turns.slice(-40),
    partial: state.partial,
    status: statusPayload(),
    technical: state.technical,
    social: state.social,
    research: state.research,
    speakers: speakers.list(),
    settings: settings.publicView()
  };
}

// Clear everything conversation-related (used on start and on demo/live switches).
function resetConversation() {
  clearTimeout(analysisTimer);
  clearTimeout(rolesTimer);
  analysisPending = false;
  rolesTurnsSince = 0;
  rolesChecks = 0;
  state.turns = [];
  state.partial = { mic: null, call: null };
  state.technical = [];
  state.social = { relevantIds: [], tip: '', at: 0 };
  state.research = isDemo() ? DEMO_RESEARCH : settings.loadResearch();
  speakers.reset();
  turnSeq = 0;
  cardSeq = 0;
}

/* ---------------- Transcription ---------------- */

function onPartialText(channel, text, meta) {
  if (!text) {
    state.partial[channel] = null;
  } else {
    const before = speakers.size;
    const speakerKey = speakers.resolve(channel, meta && meta.speakerLabel);
    if (speakers.size !== before) pushSpeakers();
    state.partial[channel] = { speakerKey, text };
  }
  toOverlay('transcript:partial', { channel, partial: state.partial[channel] });
}

let streamGen = 0; // ignore late events from streams that were already closed (stop / mode switch)

function startStreams() {
  const s = settings.load();
  const gen = ++streamGen;
  const make = (channel) => {
    const live = () => gen === streamGen && state.running;
    const handlers = {
      onPartial: (text, meta) => live() && onPartialText(channel, text, meta),
      onFinal: (text, meta) => live() && onFinalTurn(channel, text, meta),
      onStatus: (st, msg) => {
        if (gen !== streamGen) return;
        pushStatus({ [channel]: st, ...(msg ? { message: `${channel === 'mic' ? 'Your mic' : 'Call audio'}: ${msg}` } : {}) });
      }
    };
    if (s.transcriptionProvider === 'openai') {
      return createOpenAI({ apiKey: s.openaiKey, model: s.openaiTranscribeModel, vadThreshold: Number(s.vadThreshold) || 0.012, silenceMs: Number(s.silenceMs) || 800, ...handlers });
    }
    // Only the call audio is split into voices (panel interviews); the mic is always you.
    return createAssemblyAI({ apiKey: s.assemblyaiKey, speechModel: s.assemblyaiSpeechModel, diarize: channel === 'call' && s.diarize !== false, ...handlers });
  };
  streams.mic = make('mic');
  streams.call = make('call');
  return streams.mic.sampleRate;
}

function stopStreams() {
  streamGen += 1;
  for (const k of CHANNELS) {
    if (streams[k]) streams[k].close();
    streams[k] = null;
  }
}

function onFinalTurn(channel, text, meta) {
  const before = speakers.size;
  const speakerKey = speakers.resolve(channel, meta && meta.speakerLabel);
  if (speakers.size !== before) pushSpeakers();
  state.partial[channel] = null;
  const last = state.turns[state.turns.length - 1];
  let turn;
  // Merge back-to-back utterances from the same voice into one conversational turn.
  if (last && last.speakerKey === speakerKey && Date.now() - last.at < 4000) {
    last.text = `${last.text} ${text}`;
    last.at = Date.now();
    turn = last;
  } else {
    turn = { id: ++turnSeq, channel, speakerKey, text, at: Date.now() };
    state.turns.push(turn);
    if (state.turns.length > 400) state.turns.shift();
  }
  toOverlay('transcript:final', { turn: { ...turn } });
  if (!isDemo()) {
    scheduleRoleDetection(speakers.size !== before);
    scheduleAnalysis(speakerKey);
  }
}

/* ---------------- Speaker role detection (live) ---------------- */

let rolesTimer = null;
let rolesRunning = false;
let rolesTurnsSince = 0;
let rolesChecks = 0;

function scheduleRoleDetection(newVoice) {
  if (!state.running || state.paused || isDemo()) return;
  rolesTurnsSince += 1;
  // Early on, check every 2 turns until roles are settled; afterwards every 10 turns,
  // and immediately whenever a new voice shows up.
  if (!speakers.needsDetection() && !newVoice) return; // every interviewer voice already has a name
  const settled = rolesChecks >= 3;
  const every = settled ? 10 : 2;
  if (!newVoice && rolesTurnsSince < every) return;
  clearTimeout(rolesTimer);
  rolesTimer = setTimeout(runRoleDetection, 1200);
}

async function runRoleDetection() {
  const s = settings.load();
  if (!s.openaiKey || rolesRunning || !state.turns.length) return;
  rolesRunning = true;
  rolesTurnsSince = 0;
  try {
    const keys = speakers.list().filter((x) => x.channel === 'call').map((x) => x.key);
    if (!keys.length) return;
    const updates = await ai.detectRoles(s, {
      turns: state.turns.slice(-30),
      keys,
      profile: settings.loadProfile()
    });
    rolesChecks += 1;
    if (speakers.apply(updates)) pushSpeakers();
  } catch (e) {
    pushStatus({ message: `Speaker detection: ${e.message}` });
  } finally {
    rolesRunning = false;
  }
}

/* ---------------- Live analysis orchestration ---------------- */

let analysisTimer = null;
let analysisRunning = false;
let analysisPending = false;
let lastAnalysisAt = 0;

function scheduleAnalysis(speakerKey) {
  if (!state.running || state.paused) return;
  const sp = speakers.get(speakerKey);
  const fromInterviewer = sp && sp.role === 'interviewer';
  // Interviewer turns always trigger; other turns only occasionally (for social relevance).
  if (!fromInterviewer && Date.now() - lastAnalysisAt < 25000) return;
  clearTimeout(analysisTimer);
  analysisTimer = setTimeout(runAnalysis, fromInterviewer ? 900 : 1500);
}

function normalizeQ(q) {
  return q.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function addTechnicalCard(t, manual) {
  const card = { id: ++cardSeq, ...t, at: Date.now(), manual, turnId: turnSeq };
  state.technical.push(card);
  toOverlay('technical:card', card);
}

function setSocialRelevance({ relevantIds, tip }) {
  const ids = relevantIds || [];
  if (!ids.length || ids.join(',') === state.social.relevantIds.join(',')) return;
  state.social = { relevantIds: ids, tip: tip || '', at: Date.now() };
  toOverlay('social:relevant', state.social);
}

async function runAnalysis(manualQuestion) {
  if (isDemo()) {
    if (manualQuestion) addTechnicalCard({ question: manualQuestion, answer: 'Demo mode: switch to Live for real answers.', points: [], code: '' }, true);
    return;
  }
  const s = settings.load();
  if (!s.openaiKey) {
    pushStatus({ ai: 'error', message: 'Add an OpenAI API key in Settings to get answers.' });
    return;
  }
  if (analysisRunning && !manualQuestion) {
    analysisPending = true;
    return;
  }
  const modeAtStart = state.mode;
  analysisRunning = true;
  lastAnalysisAt = Date.now();
  pushStatus({ ai: 'thinking' });
  try {
    const result = await ai.analyze(s, {
      profile: settings.loadProfile(),
      turns: state.turns.slice(-16).map((t) => ({ ...t, label: speakers.promptLabel(t.speakerKey) })),
      research: state.research,
      answered: state.technical.map((c) => c.question).slice(-12),
      manualQuestion
    });
    if (state.mode !== modeAtStart) return; // switched modes while thinking: drop the result

    const t = result.technical;
    if (t.detected) {
      const dup = !manualQuestion && state.technical.some((c) => normalizeQ(c.question) === normalizeQ(t.question));
      if (!dup) addTechnicalCard(t, !!manualQuestion);
    }
    setSocialRelevance(result.social);
    pushStatus({ ai: 'idle', message: '' });
  } catch (e) {
    pushStatus({ ai: 'error', message: `AI: ${e.message}` });
  } finally {
    analysisRunning = false;
    if (analysisPending) {
      analysisPending = false;
      setTimeout(runAnalysis, 200);
    }
  }
}

/* ---------------- Windows ---------------- */

function createSetupWindow() {
  if (setupWin && !setupWin.isDestroyed()) {
    setupWin.show();
    setupWin.focus();
    return;
  }
  setupWin = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 760,
    minHeight: 600,
    title: 'Interview Copilot',
    backgroundColor: '#0E1014',
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
  });
  setupWin.loadFile(path.join(RENDERER, 'setup.html'));
  setupWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  setupWin.on('closed', () => {
    setupWin = null;
    if (!overlayWin) app.quit();
  });
}

function createOverlayWindow() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  const { workArea } = screen.getPrimaryDisplay();
  overlayWin = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setIgnoreMouseEvents(true, { forward: true });
  overlayWin.setContentProtection(!!settings.load().hideFromScreenShare);
  overlayWin.loadFile(path.join(RENDERER, 'overlay.html'));
  overlayWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  overlayWin.on('closed', () => {
    overlayWin = null;
    stopSession();
  });
  return overlayWin;
}

/* ---------------- Session control ---------------- */

function validateForStart() {
  if (isDemo()) return null;
  const s = settings.load();
  if (s.transcriptionProvider === 'assemblyai' && !s.assemblyaiKey) return 'Add an AssemblyAI API key (or switch transcription to OpenAI) in Settings.';
  if (s.transcriptionProvider === 'openai' && !s.openaiKey) return 'Add an OpenAI API key in Settings.';
  if (!s.openaiKey) return 'Add an OpenAI API key in Settings — it powers the answers and research.';
  return null;
}

function showOverlay(sendBegin) {
  const win = createOverlayWindow();
  const run = () => sendBegin(win);
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', run);
  else run();
  win.showInactive();
  return win;
}

async function startSession() {
  const err = validateForStart();
  if (err) {
    pushStatus({ message: err });
    return { ok: false, error: err };
  }
  if (!isDemo() && process.platform === 'darwin') {
    try {
      await systemPreferences.askForMediaAccess('microphone');
    } catch {}
  }
  if (state.running) stopSession();

  resetConversation();
  state.running = true;
  state.paused = false;

  let sampleRate = 16000;
  if (isDemo()) {
    stopDemo = runDemo({
      onPartial: (channel, text) => onPartialText(channel, text),
      onFinal: (channel, text) => onFinalTurn(channel, text),
      onTechnical: (t) => addTechnicalCard(t, false),
      onSocial: setSocialRelevance,
      onRoles: (updates) => speakers.apply(updates, { source: 'ai' }) && pushSpeakers()
    });
    state.status = { mic: 'live', call: 'live', ai: 'idle', message: '' };
  } else {
    state.status = { mic: 'connecting', call: 'connecting', ai: 'idle', message: '' };
    sampleRate = startStreams();
  }
  const s = settings.load();
  showOverlay((win) =>
    win.webContents.send('session:begin', {
      sampleRate,
      micDeviceId: s.micDeviceId,
      interviewerSource: s.interviewerSource,
      demo: isDemo(),
      snapshot: snapshot()
    })
  );
  pushStatus({ message: '' });
  if (setupWin) setupWin.minimize();
  return { ok: true };
}

function stopSession() {
  if (!state.running) return;
  state.running = false;
  state.paused = false;
  clearTimeout(analysisTimer);
  clearTimeout(rolesTimer);
  if (stopDemo) stopDemo();
  stopDemo = null;
  stopStreams();
  state.partial = { mic: null, call: null };
  toOverlay('session:end', {});
  pushStatus({ mic: 'idle', call: 'idle', ai: 'idle' });
}

// Demo <-> Live: stop, wipe the whole conversation, and restart in the new mode if it was running.
async function setMode(mode) {
  if (mode !== 'demo' && mode !== 'live') return { ok: false, error: 'Unknown mode' };
  if (mode === state.mode) return { ok: true, mode };
  const wasRunning = state.running;
  stopSession();
  state.mode = mode;
  resetConversation();
  state.status = { mic: 'idle', call: 'idle', ai: 'idle', message: '' };
  toOverlay('session:reset', snapshot());
  pushStatus({});
  if (wasRunning) {
    const r = await startSession();
    if (!r.ok) return { ok: true, mode, warning: r.error };
  }
  return { ok: true, mode };
}

/* ---------------- IPC ---------------- */

function registerIpc() {
  ipcMain.handle('settings:get', () => settings.publicView());
  ipcMain.handle('settings:set', (_e, partial) => {
    const view = settings.save(partial);
    if (overlayWin) {
      overlayWin.setContentProtection(!!settings.load().hideFromScreenShare);
      toOverlay('settings', view);
    }
    return view;
  });
  ipcMain.handle('settings:clearKey', (_e, key) => settings.clearSecret(key));
  ipcMain.handle('settings:testOpenAI', async () => {
    const s = settings.load();
    if (!s.openaiKey) return { ok: false, error: 'No OpenAI key saved' };
    try {
      await ai.testKey(s.openaiKey, s.liveModel);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('profile:get', () => settings.loadProfile());
  ipcMain.handle('profile:set', (_e, p) => settings.saveProfile(p));

  ipcMain.handle('research:get', () => settings.loadResearch());
  ipcMain.handle('research:run', async () => {
    const s = settings.load();
    if (!s.openaiKey) return { ok: false, error: 'Add an OpenAI API key in Settings first.' };
    const profile = settings.loadProfile();
    if (!profile.interviewerName && !profile.company) return { ok: false, error: 'Enter at least the interviewer or the company.' };
    try {
      const r = await ai.research(s, profile);
      settings.saveResearch(r);
      state.research = r;
      toOverlay('research', r);
      return { ok: true, research: r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('session:start', () => startSession());
  // Stop keeps the overlay on screen (research and answers stay visible) so Start can resume.
  ipcMain.handle('session:stop', () => {
    stopSession();
    return { ok: true };
  });
  ipcMain.handle('session:pause', (_e, paused) => {
    state.paused = !!paused;
    pushStatus({});
    return { paused: state.paused };
  });
  ipcMain.handle('session:snapshot', () => snapshot());
  ipcMain.handle('mode:set', (_e, mode) => setMode(mode));
  ipcMain.handle('session:ask', async (_e, q) => {
    const question = String(q || '').trim().slice(0, 1000);
    if (!question) return { ok: false };
    await runAnalysis(question);
    return { ok: true };
  });

  // Audio frames from the overlay renderer: Int16 PCM, 100 ms each.
  ipcMain.on('audio:chunk', (_e, { channel, data, rms }) => {
    if (!state.running || isDemo()) return;
    const st = streams[channel];
    if (!st) return;
    // While paused, send silence so the transcription connection stays open but hears nothing.
    if (state.paused) st.send(Buffer.alloc(data.byteLength), 0);
    else st.send(Buffer.from(data), rms);
  });
  ipcMain.on('audio:error', (_e, { channel, message }) => {
    pushStatus({ [channel]: 'error', message: `${channel === 'mic' ? 'Microphone' : 'Call audio'}: ${message}` });
  });

  // Click-through: the overlay tells us when the cursor is over something clickable.
  ipcMain.on('overlay:interactive', (_e, on) => {
    if (!overlayWin) return;
    overlayWin.setIgnoreMouseEvents(!on, { forward: true });
    if (on) overlayWin.setFocusable(true);
  });
  ipcMain.on('overlay:focusInput', () => {
    if (overlayWin) overlayWin.focus();
  });
  ipcMain.on('app:openSetup', () => createSetupWindow());
}

/* ---------------- App lifecycle ---------------- */

function registerShortcuts() {
  const mod = 'CommandOrControl+Shift';
  globalShortcut.register(`${mod}+H`, () => {
    if (!overlayWin) return;
    if (overlayWin.isVisible()) overlayWin.hide();
    else overlayWin.showInactive();
  });
  globalShortcut.register(`${mod}+1`, () => toOverlay('hotkey', { tab: 'social' }));
  globalShortcut.register(`${mod}+2`, () => toOverlay('hotkey', { tab: 'technical' }));
  globalShortcut.register(`${mod}+0`, () => toOverlay('hotkey', { tab: null }));
}

app.whenReady().then(() => {
  // System-audio capture: getDisplayMedia() in the overlay resolves to the primary
  // screen with loopback audio, no picker. The video track is discarded immediately.
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
        .catch(() => callback({}));
    },
    { useSystemPicker: false }
  );
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'clipboard-sanitized-write'].includes(permission));
  });

  registerIpc();
  registerShortcuts();
  createSetupWindow();

  if (process.env.COPILOT_DEBUG || SMOKE) {
    app.on('web-contents-created', (_e, wc) =>
      wc.on('console-message', (ev) => console.log(`[renderer] ${ev.level || ''} ${ev.message}`))
    );
  }
  if (isDemo()) setTimeout(() => startSession(), 600);
  if (SMOKE) {
    const fs = require('fs');
    const shot = async (suffix) => fs.writeFileSync(SMOKE.replace(/\.png$/, suffix + '.png'), (await overlayWin.webContents.capturePage()).toPNG());
    setTimeout(async () => {
      await shot('');
      await setMode('live');
      await new Promise((r) => setTimeout(r, 1500));
      await shot('-after-switch');
      await setMode('demo');
      await new Promise((r) => setTimeout(r, 9000));
      await shot('-demo-again');
      app.exit(0);
    }, 14000);
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopSession();
});

app.on('window-all-closed', () => app.quit());

app.on('activate', () => createSetupWindow());
