// OpenAI Realtime transcription session — one WebSocket per speaker stream.
// Docs: https://developers.openai.com/api/docs/guides/realtime-transcription
// gpt-live-transcribe does not do server-side turn detection, so we run a small
// energy-based VAD here: stream audio while someone is talking, then commit the
// buffer after `silenceMs` of quiet. Each committed buffer = one finished utterance.
const WebSocket = require('ws');

const SAMPLE_RATE = 24000;
const CHUNK_MS = 100; // the renderer sends 100 ms frames
const PREROLL_CHUNKS = 3; // keep ~300 ms before speech starts so first words aren't clipped
const MIN_SPEECH_MS = 200;
const MAX_UTTERANCE_MS = 20000; // force a commit on long monologues to keep latency down

function createOpenAI({ apiKey, model, vadThreshold = 0.012, silenceMs = 800, onPartial, onFinal, onStatus }) {
  let ws = null;
  let closedByUs = false;
  let retries = 0;

  // VAD state
  let speaking = false;
  let speechMs = 0;
  let silence = 0;
  let utteranceMs = 0;
  let appendedSinceCommit = false;
  const preroll = [];

  // Transcript assembly per item
  const partials = new Map(); // item_id -> text

  function sendJson(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function connect() {
    onStatus('connecting');
    ws = new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', {
      headers: { Authorization: `Bearer ${apiKey}` }
    });

    ws.on('open', () => {
      retries = 0;
      sendJson({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: SAMPLE_RATE },
              transcription: { model },
              turn_detection: null
            }
          }
        }
      });
      onStatus('live');
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (msg.type) {
        case 'conversation.item.input_audio_transcription.delta': {
          const text = (partials.get(msg.item_id) || '') + (msg.delta || '');
          partials.set(msg.item_id, text);
          onPartial(text);
          break;
        }
        case 'conversation.item.input_audio_transcription.completed': {
          partials.delete(msg.item_id);
          const text = (msg.transcript || '').trim();
          if (text) onFinal(text);
          else onPartial('');
          break;
        }
        case 'conversation.item.input_audio_transcription.failed':
          onStatus('error', (msg.error && msg.error.message) || 'Transcription failed');
          break;
        case 'error': {
          const m = (msg.error && msg.error.message) || 'OpenAI realtime error';
          // An empty-buffer commit is harmless; ignore it.
          if (!/buffer too small|empty/i.test(m)) onStatus('error', m);
          break;
        }
        default:
          break;
      }
    });

    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => onStatus('error', `OpenAI rejected the connection (${res.statusCode}) ${body.slice(0, 200)}`));
    });

    ws.on('error', (err) => onStatus('error', err.message));

    ws.on('close', (code, reason) => {
      if (closedByUs) return onStatus('closed');
      if (code === 1008 || code === 4001 || retries >= 5) {
        return onStatus('error', `OpenAI closed (${code}) ${reason || ''}`.trim());
      }
      retries += 1;
      onStatus('reconnecting');
      setTimeout(connect, 500 * retries);
    });
  }

  function append(buf) {
    sendJson({ type: 'input_audio_buffer.append', audio: Buffer.from(buf).toString('base64') });
    appendedSinceCommit = true;
  }

  function commit() {
    if (appendedSinceCommit) sendJson({ type: 'input_audio_buffer.commit' });
    appendedSinceCommit = false;
    utteranceMs = 0;
  }

  connect();

  return {
    sampleRate: SAMPLE_RATE,
    send(pcm16, rms) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const loud = rms >= vadThreshold;

      if (!speaking) {
        preroll.push(pcm16);
        if (preroll.length > PREROLL_CHUNKS) preroll.shift();
        speechMs = loud ? speechMs + CHUNK_MS : 0;
        if (speechMs >= MIN_SPEECH_MS) {
          speaking = true;
          silence = 0;
          for (const b of preroll) append(b);
          utteranceMs = preroll.length * CHUNK_MS;
          preroll.length = 0;
        }
        return;
      }

      append(pcm16);
      utteranceMs += CHUNK_MS;
      silence = loud ? 0 : silence + CHUNK_MS;

      if (silence >= silenceMs || utteranceMs >= MAX_UTTERANCE_MS) {
        commit();
        if (silence >= silenceMs) {
          speaking = false;
          speechMs = 0;
        }
        silence = 0;
      }
    },
    close() {
      closedByUs = true;
      try {
        commit();
      } catch {}
      setTimeout(() => {
        try {
          ws && ws.close();
        } catch {}
      }, 300);
    }
  };
}

module.exports = { createOpenAI, SAMPLE_RATE };
