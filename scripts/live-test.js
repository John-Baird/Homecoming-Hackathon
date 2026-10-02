// Live end-to-end test against the real APIs (uses keys from .env or environment).
// Never prints keys. Usage:
//   npm run live-test
//   npm run live-test -- --research "Interviewer Name" "Company"     (also runs web research)
//   npm run live-test -- --model gpt-5.4-mini --transcribe-model gpt-live-transcribe
const path = require('path');
const root = path.join(__dirname, '..');
require(path.join(root, 'src/main/env.js')).loadEnv(root);

const ai = require(path.join(root, 'src/main/ai.js'));
const { createAssemblyAI } = require(path.join(root, 'src/main/transcribe/assemblyai.js'));
const { createOpenAI } = require(path.join(root, 'src/main/transcribe/openai.js'));

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const MODEL = opt('--model', 'gpt-5.4-mini');
const TRANSCRIBE_MODEL = opt('--transcribe-model', 'gpt-live-transcribe');
const OPENAI = process.env.OPENAI_API_KEY || '';
const ASSEMBLY = process.env.ASSEMBLYAI_API_KEY || '';

const results = [];
const pass = (name, detail = '') => {
  results.push({ name, ok: true });
  console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
};
const fail = (name, err) => {
  results.push({ name, ok: false });
  console.log(`  FAIL  ${name} — ${err && err.message ? err.message : err}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const settings = { openaiKey: OPENAI, liveModel: MODEL, researchModel: MODEL, reasoningEffort: 'low' };

const SAMPLE_SPEECH = 'Thanks for joining today. How would you design a rate limiter for a public API?';

async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    fail(name, e);
  }
}

// Text-to-speech to get real audio to stream: 24 kHz 16-bit mono PCM.
async function synthesize(text) {
  for (const model of ['gpt-4o-mini-tts', 'tts-1']) {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, voice: 'alloy', input: text, response_format: 'pcm' })
    });
    if (res.ok) return { pcm: Buffer.from(await res.arrayBuffer()), model };
  }
  throw new Error('Could not generate test audio with OpenAI TTS');
}

function resample24to16(buf) {
  const src = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  const outLen = Math.floor((src.length * 2) / 3);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = i * 1.5;
    const i0 = Math.floor(x);
    const f = x - i0;
    const a = src[i0] || 0;
    const b = src[i0 + 1] || a;
    out[i] = Math.round(a + (b - a) * f);
  }
  return Buffer.from(out.buffer);
}

function rmsOf(chunk) {
  const s = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.length / 2));
  let sum = 0;
  for (const v of s) sum += (v / 32768) ** 2;
  return Math.sqrt(sum / (s.length || 1));
}

// Stream audio in real time (100 ms frames), then trailing silence so a turn can end.
async function streamAudio(provider, pcm, rate, silenceSec = 3) {
  const frame = (rate / 10) * 2;
  const silence = Buffer.alloc(frame);
  for (let o = 0; o < pcm.length; o += frame) {
    let c = pcm.subarray(o, o + frame);
    if (c.length < frame) c = Buffer.concat([c, Buffer.alloc(frame - c.length)]);
    provider.send(c, rmsOf(c));
    await sleep(100);
  }
  for (let i = 0; i < silenceSec * 10; i++) {
    provider.send(silence, 0);
    await sleep(100);
  }
}

function transcriptionTest(name, factory, pcm, rate) {
  return new Promise((resolve) => {
    const finals = [];
    let lastErr = null;
    let live = false;
    const p = factory({
      onPartial: () => {},
      onFinal: (t) => finals.push(t),
      onStatus: (s, m) => {
        if (s === 'live') live = true;
        if (s === 'error') lastErr = m;
      }
    });
    (async () => {
      for (let i = 0; i < 50 && !live && !lastErr; i++) await sleep(100);
      if (!live) {
        fail(name, lastErr || 'never connected');
        p.close();
        return resolve();
      }
      await streamAudio(p, pcm, rate);
      for (let i = 0; i < 40 && !finals.length && !lastErr; i++) await sleep(250);
      p.close();
      const text = finals.join(' ');
      if (text && /rate limit/i.test(text)) pass(name, `"${text}"`);
      else fail(name, lastErr || (text ? `unexpected transcript: "${text}"` : 'no final turn received'));
      resolve();
    })();
  });
}

(async () => {
  console.log(`\nInterview Copilot live test  (model: ${MODEL})\n`);
  if (!OPENAI) console.log('  SKIP  OpenAI tests — OPENAI_API_KEY not set');
  if (!ASSEMBLY) console.log('  SKIP  AssemblyAI tests — ASSEMBLYAI_API_KEY not set');

  if (OPENAI) {
    await step('OpenAI key + live model', async () => {
      await ai.testKey(OPENAI, MODEL);
      pass('OpenAI key + live model', MODEL);
    });

    await step('Live analysis (technical + social)', async () => {
      const research = ai.normalizeResearch(
        {
          interviewer: { name: 'Test Person', posts: [{ title: 'Why we built our own API gateway', summary: 'Post about rate limiting and API gateways.' }], achievements: [] },
          company: { name: 'Test Co', posts: [], achievements: [] }
        },
        {}
      );
      const t0 = Date.now();
      const r = await ai.analyze(settings, {
        profile: { jobTitle: 'Backend Engineer', company: 'Test Co' },
        turns: [
          { speaker: 'interviewer', text: 'Thanks for joining. Tell me a bit about yourself.' },
          { speaker: 'you', text: 'I build backend services, mostly APIs and data pipelines.' },
          { speaker: 'interviewer', text: 'Great. How would you design a rate limiter for a public API?' }
        ],
        research,
        answered: []
      });
      const ms = Date.now() - t0;
      if (!r.technical.detected) throw new Error('did not detect the technical question');
      pass('Live analysis (technical + social)', `${ms} ms · Q: "${r.technical.question}" · ${r.technical.points.length} points · social ids: [${r.social.relevantIds.join(', ')}]`);
      if (ms > 6000) console.log('        note: slow for live use — try a faster model or reasoning effort "minimal"/off');
    });

    await step('Interviewer name detection', async () => {
      const r = await ai.detectRoles(settings, {
        keys: ['call:A', 'call:B'],
        profile: { company: 'Test Co' },
        turns: [
          { speakerKey: 'call:A', text: "Hi, I'm Priya, I lead the platform team here. This is Sam from recruiting." },
          { speakerKey: 'call:B', text: "Hi! I'll just be taking notes and handling scheduling afterwards." },
          { speakerKey: 'mic:A', text: 'Nice to meet you both. I have been working on backend APIs for five years.' },
          { speakerKey: 'call:A', text: 'Great. Can you walk me through how you would shard a large Postgres table?' }
        ]
      });
      const by = Object.fromEntries(r.map((x) => [x.key, x]));
      const desc = r.map((x) => `${x.key}=${x.role}${x.name ? '(' + x.name + ')' : ''}`).join(' ');
      if (!by['call:A'] || !/priya/i.test(by['call:A'].name)) throw new Error('expected call:A = Priya — got ' + desc);
      pass('Interviewer name detection', desc);
    });

    const ri = args.indexOf('--research');
    if (ri >= 0) {
      const name = args[ri + 1] || '';
      const company = args[ri + 2] || '';
      await step('Web research', async () => {
        const t0 = Date.now();
        const r = await ai.research(settings, { interviewerName: name, company });
        const n = r.interviewer.posts.length + r.interviewer.achievements.length + r.company.posts.length + r.company.achievements.length;
        const withUrl = ai.socialItems(r).filter((x) => /^https?:/.test(x.url)).length;
        pass('Web research', `${Math.round((Date.now() - t0) / 1000)} s · ${n} items (${withUrl} with source links)`);
        for (const it of ai.socialItems(r).slice(0, 6)) console.log(`        - [${it.group} ${it.kind}] ${it.title}${it.url ? '  ' + it.url : ''}`);
      });
    }
  }

  let audio = null;
  if (OPENAI && (ASSEMBLY || true)) {
    await step('Generate test speech', async () => {
      audio = await synthesize(SAMPLE_SPEECH);
      pass('Generate test speech', `${audio.model}, ${(audio.pcm.length / 48000).toFixed(1)} s`);
    });
  }

  if (audio && ASSEMBLY) {
    await transcriptionTest('AssemblyAI streaming + turn detection', (h) => createAssemblyAI({ apiKey: ASSEMBLY, ...h }), resample24to16(audio.pcm), 16000);
  }
  if (audio && OPENAI) {
    await transcriptionTest(`OpenAI realtime transcription (${TRANSCRIBE_MODEL})`, (h) => createOpenAI({ apiKey: OPENAI, model: TRANSCRIBE_MODEL, ...h }), audio.pcm, 24000);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed\n`);
  setTimeout(() => process.exit(failed ? 1 : 0), 500);
})();
