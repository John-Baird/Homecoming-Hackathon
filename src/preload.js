// Narrow, whitelisted bridge between renderers and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'settings:get', 'settings:set', 'settings:clearKey', 'settings:testOpenAI',
  'profile:get', 'profile:set',
  'research:get', 'research:run',
  'session:start', 'session:stop', 'session:pause', 'session:snapshot', 'session:ask', 'mode:set'
]);
const SEND = new Set(['audio:chunk', 'audio:error', 'overlay:interactive', 'overlay:focusInput', 'app:openSetup']);
const ON = new Set([
  'status', 'session:status', 'session:begin', 'session:end', 'settings', 'research',
  'transcript:partial', 'transcript:final', 'technical:card', 'social:relevant', 'hotkey',
  'speakers', 'session:reset'
]);

contextBridge.exposeInMainWorld('copilot', {
  platform: process.platform,
  invoke(channel, ...args) {
    if (!INVOKE.has(channel)) throw new Error('Blocked channel ' + channel);
    return ipcRenderer.invoke(channel, ...args);
  },
  send(channel, payload) {
    if (!SEND.has(channel)) throw new Error('Blocked channel ' + channel);
    ipcRenderer.send(channel, payload);
  },
  on(channel, fn) {
    if (!ON.has(channel)) throw new Error('Blocked channel ' + channel);
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});
