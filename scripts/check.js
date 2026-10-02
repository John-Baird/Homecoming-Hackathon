// Offline sanity checks (no Electron, no network): syntax, JSON parsing, research
// normalization, and both transcription providers against a fake WebSocket.
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { execFileSync } = require('child_process');
const EventEmitter = require('events');

const root = path.join(__dirname, '..');
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
})(path.join(root, 'src'));
for (const f of files) execFileSync(process.execPath, ['--check', f]);
console.log(`✓ syntax ok (${files.length} files)`);

// ---- Fake ws module ----
const sockets = [];
class FakeWS extends EventEmitter {
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.readyState = 0;
    this.sent = [];
    sockets.push(this);
    setImmediate(() => {
      this.readyState = 1;
      this.emit('open');
    });
  }
  send(d) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.emit('close', 1000, '');
  }
  serverSays(obj) {
    this.emit('message', Buffer.from(JSON.stringify(obj)));
  }
}
FakeWS.OPEN = 1;
require.cache[require.resolve('ws', { paths: [root] })] = { exports: FakeWS, loaded: true, id: 'ws' };

// Electron stub so ai.js (pure) loads without Electron.
const ai = require(path.join(root, 'src/main/ai.js'));

// ---- extractJson ----
assert.deepStrictEqual(ai.extractJson('Here:\n```json\n{"a":{"b":"}"}}\n```'), { a: { b: '}' } });
assert.deepStrictEqual(ai.extractJson('prefix {"x":1} suffix {"y":2}'), { x: 1 });
assert.strictEqual(ai.extractJson('no json'), null);
console.log('✓ extractJson');

// ---- normalizeResearch ----
const r = ai.normalizeResearch(
  {
    interviewer: { name: 'A B', posts: [{ title: 'Post', summary: 's', url: 'https://x' }, {}], achievements: [{ title: 'Ach' }] },
    company: { posts: [], achievements: [{ title: 'M', detail: 'd' }] },
    conversationStarters: ['Q1', 3]
  },
  { company: 'Acme' }
);
assert.strictEqual(r.interviewer.posts.length, 1);
assert.strictEqual(r.company.name, 'Acme');
assert.deepStrictEqual(r.conversationStarters, ['Q1']);
const ids = ai.socialItems(r).map((x) => x.id);
assert.strictEqual(new Set(ids).size, ids.length);
console.log('✓ normalizeResearch');

// ---- Speaker registry ----
const { createSpeakerRegistry } = require(path.join(root, 'src/main/speakers.js'));
const reg = createSpeakerRegistry();
assert.strictEqual(reg.resolve('mic', null), 'mic:A');
assert.strictEqual(reg.resolve('call', 'B'), 'call:B');
assert.strictEqual(reg.resolve('call', 'PENDING'), 'call:B'); // pending → last voice on channel
assert.strictEqual(reg.get('mic:A').role, 'candidate');
assert.strictEqual(reg.get('call:B').role, 'interviewer');
assert.ok(reg.apply([{ key: 'call:B', role: 'interviewer', name: 'Jordan', confidence: 0.9 }]));
assert.ok(!reg.apply([{ key: 'call:B', role: 'candidate', name: 'X', confidence: 0.3 }])); // low confidence ignored
assert.ok(!reg.apply([{ key: 'mic:A', role: 'interviewer', name: 'Bob', confidence: 1 }])); // mic is always You
assert.strictEqual(reg.get('call:B').role, 'interviewer');
const disp = Object.fromEntries(reg.list().map((x) => [x.key, x.name]));
assert.strictEqual(disp['call:B'], 'Jordan');
assert.strictEqual(disp['mic:A'], 'You');
assert.ok(reg.promptLabel('call:B').startsWith('Interviewer'));
reg.reset();
assert.strictEqual(reg.size, 0);
console.log('✓ speaker registry');

(async () => {
  const tick = () => new Promise((res) => setImmediate(res));

  // ---- AssemblyAI ----
  const { createAssemblyAI } = require(path.join(root, 'src/main/transcribe/assemblyai.js'));
  const aFinals = [];
  const aPartials = [];
  const aMeta = [];
  const a = createAssemblyAI({ apiKey: 'k', onPartial: (t) => aPartials.push(t), onFinal: (t, m) => (aFinals.push(t), aMeta.push(m)), onStatus: () => {} });
  await tick();
  const aws = sockets[sockets.length - 1];
  assert.ok(aws.url.startsWith('wss://streaming.assemblyai.com/v3/ws?'));
  assert.ok(aws.url.includes('format_turns=true'));
  assert.ok(aws.url.includes('speaker_labels=true'));
  assert.strictEqual(aws.opts.headers.Authorization, 'k');
  aws.serverSays({ type: 'Begin' });
  aws.serverSays({ type: 'Turn', turn_order: 0, end_of_turn: false, transcript: 'how would' });
  aws.serverSays({ type: 'Turn', turn_order: 0, end_of_turn: true, turn_is_formatted: false, transcript: 'how would you' });
  aws.serverSays({ type: 'Turn', turn_order: 0, end_of_turn: true, turn_is_formatted: true, transcript: 'How would you?', speaker_label: 'B' });
  aws.serverSays({ type: 'Turn', turn_order: 0, end_of_turn: true, turn_is_formatted: true, transcript: 'dup' });
  assert.deepStrictEqual(aFinals, ['How would you?']);
  assert.strictEqual(aMeta[0].speakerLabel, 'B');
  a.send(Buffer.alloc(3200));
  assert.strictEqual(aws.sent.length, 1);
  a.close();
  console.log('✓ AssemblyAI provider');

  // ---- OpenAI realtime + client VAD ----
  const { createOpenAI } = require(path.join(root, 'src/main/transcribe/openai.js'));
  const oFinals = [];
  const o = createOpenAI({ apiKey: 'k', model: 'm', silenceMs: 500, onPartial: () => {}, onFinal: (t) => oFinals.push(t), onStatus: () => {} });
  await tick();
  const ows = sockets[sockets.length - 1];
  assert.ok(ows.url.includes('intent=transcription'));
  assert.strictEqual(ows.opts.headers.Authorization, 'Bearer k');
  const upd = JSON.parse(ows.sent[0]);
  assert.strictEqual(upd.type, 'session.update');
  assert.strictEqual(upd.session.audio.input.transcription.model, 'm');
  const chunk = Buffer.alloc(4800);
  // 5 quiet frames: nothing sent
  for (let i = 0; i < 5; i++) o.send(chunk, 0.001);
  assert.strictEqual(ows.sent.length, 1);
  // 6 loud frames: speech starts after 200ms, preroll flushed
  for (let i = 0; i < 6; i++) o.send(chunk, 0.05);
  const appends = ows.sent.filter((s) => JSON.parse(s).type === 'input_audio_buffer.append').length;
  assert.ok(appends >= 5, 'appends after speech start: ' + appends);
  // 5 quiet frames (500ms) => commit
  for (let i = 0; i < 5; i++) o.send(chunk, 0.001);
  const commits = ows.sent.filter((s) => JSON.parse(s).type === 'input_audio_buffer.commit').length;
  assert.strictEqual(commits, 1);
  // after commit and silence, quiet frames are not sent
  const before = ows.sent.length;
  for (let i = 0; i < 3; i++) o.send(chunk, 0.001);
  assert.strictEqual(ows.sent.length, before);
  ows.serverSays({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'i1', delta: 'Hel' });
  ows.serverSays({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'Hello there.' });
  assert.deepStrictEqual(oFinals, ['Hello there.']);
  o.close();
  console.log('✓ OpenAI provider + VAD');
  console.log('All checks passed.');
  setTimeout(() => process.exit(0), 400);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
