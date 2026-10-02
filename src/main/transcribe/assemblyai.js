// AssemblyAI Universal Streaming (v3) — one WebSocket per speaker stream.
// Docs: https://www.assemblyai.com/docs/streaming/api-spec/streaming-websocket
// Built-in end-of-turn detection: a "Turn" message with end_of_turn=true closes a turn.
const WebSocket = require('ws');

const SAMPLE_RATE = 16000;

function createAssemblyAI({ apiKey, speechModel, diarize = true, onPartial, onFinal, onStatus }) {
  let ws = null;
  let closedByUs = false;
  let retries = 0;
  const finalized = new Set(); // turn_order values already emitted as final
  const pendingTimers = new Map();

  function url() {
    const p = new URLSearchParams({
      sample_rate: String(SAMPLE_RATE),
      encoding: 'pcm_s16le',
      format_turns: 'true'
    });
    if (speechModel) p.set('speech_model', speechModel);
    // Streaming diarization: each Turn carries speaker_label ("A", "B", … or "PENDING").
    if (diarize) p.set('speaker_labels', 'true');
    return 'wss://streaming.assemblyai.com/v3/ws?' + p.toString();
  }

  const labels = new Map(); // turn_order -> speaker_label
  function emitFinal(order, text) {
    if (finalized.has(order)) return;
    finalized.add(order);
    const t = pendingTimers.get(order);
    if (t) clearTimeout(t);
    pendingTimers.delete(order);
    const clean = (text || '').trim();
    if (clean) onFinal(clean, { speakerLabel: labels.get(order) || null });
    else onPartial('');
    labels.delete(order);
  }

  function connect() {
    onStatus('connecting');
    ws = new WebSocket(url(), { headers: { Authorization: apiKey } });

    ws.on('open', () => {
      retries = 0;
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'Begin') {
        onStatus('live');
      } else if (msg.type === 'Turn') {
        const order = msg.turn_order;
        if (finalized.has(order)) return;
        if (msg.speaker_label && msg.speaker_label !== 'PENDING') labels.set(order, msg.speaker_label);
        else if (Array.isArray(msg.words)) {
          // Fall back to the most common word-level speaker in this turn.
          const counts = {};
          for (const w of msg.words) if (w.speaker && w.speaker !== 'PENDING') counts[w.speaker] = (counts[w.speaker] || 0) + 1;
          const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
          if (top) labels.set(order, top[0]);
        }
        if (msg.end_of_turn) {
          if (msg.turn_is_formatted) {
            emitFinal(order, msg.transcript);
          } else {
            // Formatted version usually follows within a moment; fall back to raw text.
            onPartial(msg.transcript || '', { speakerLabel: labels.get(order) || null });
            if (!pendingTimers.has(order)) {
              pendingTimers.set(order, setTimeout(() => emitFinal(order, msg.transcript), 1500));
            }
          }
        } else {
          onPartial(msg.transcript || '', { speakerLabel: labels.get(order) || null });
        }
      } else if (msg.type === 'Termination') {
        onStatus('closed');
      } else if (msg.type === 'Error' || msg.error) {
        onStatus('error', msg.error || 'AssemblyAI error');
      }
    });

    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => onStatus('error', `AssemblyAI rejected the connection (${res.statusCode}) ${body.slice(0, 200)}`));
    });

    ws.on('error', (err) => onStatus('error', err.message));

    ws.on('close', (code, reason) => {
      if (closedByUs) return onStatus('closed');
      // 1008/4001-ish = auth or policy problem: don't hammer the API
      if (code === 1008 || (code >= 4000 && code < 4100) || retries >= 5) {
        return onStatus('error', `AssemblyAI closed (${code}) ${reason || ''}`.trim());
      }
      retries += 1;
      onStatus('reconnecting');
      setTimeout(connect, 500 * retries);
    });
  }

  connect();

  return {
    sampleRate: SAMPLE_RATE,
    send(pcm16) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(pcm16);
    },
    close() {
      closedByUs = true;
      for (const t of pendingTimers.values()) clearTimeout(t);
      try {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'Terminate' }));
      } catch {}
      setTimeout(() => {
        try {
          ws && ws.close();
        } catch {}
      }, 300);
    }
  };
}

module.exports = { createAssemblyAI, SAMPLE_RATE };
