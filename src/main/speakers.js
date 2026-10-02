// Speaker registry: who is talking, and in what role.
//
// Audio arrives on two channels — "mic" (this computer's microphone) and "call"
// (the call's audio). With diarization on, AssemblyAI also labels distinct voices
// within a channel (A, B, …), so a panel interview becomes call:A, call:B, …
// Roles are fixed by channel: the mic is always you (the interviewee) and the call
// audio is always the interviewer side. The AI only fills in names (e.g. "Hi, I'm Jordan").

const ROLE_TITLE = { candidate: 'Candidate', interviewer: 'Interviewer', other: 'Other', unknown: 'Speaker' };

function createSpeakerRegistry() {
  let speakers = new Map(); // key -> speaker
  let lastOnChannel = { mic: null, call: null };
  let version = 0;

  function reset() {
    speakers = new Map();
    lastOnChannel = { mic: null, call: null };
    version += 1;
  }

  function defaultRole(channel) {
    return channel === 'mic' ? 'candidate' : 'interviewer';
  }

  // Map a provider's speaker label (or none) on a channel to a stable speaker key.
  function resolve(channel, label) {
    const clean = typeof label === 'string' && /^[A-Z]{1,2}$/.test(label) ? label : null;
    let key;
    if (clean) key = `${channel}:${clean}`;
    else key = lastOnChannel[channel] || `${channel}:A`; // PENDING / unlabelled → last voice on that channel
    if (!speakers.has(key)) {
      speakers.set(key, {
        key,
        channel,
        label: key.split(':')[1],
        role: defaultRole(channel),
        name: '',
        confidence: 0,
        source: 'default',
        firstSeen: Date.now()
      });
      version += 1;
    }
    lastOnChannel[channel] = key;
    return key;
  }

  function get(key) {
    return speakers.get(key) || null;
  }

  // Apply AI (or demo) role/name decisions. Returns true when anything visible changed.
  function apply(updates, { minConfidence = 0.6, source = 'ai' } = {}) {
    let changed = false;
    for (const u of updates || []) {
      const s = speakers.get(u.key);
      if (!s) continue;
      const conf = typeof u.confidence === 'number' ? u.confidence : 1;
      if (conf < minConfidence) continue;
      // Roles never change (mic = interviewee, call = interviewer); only names are learned.
      if (s.channel === 'mic') continue; // the mic is always "You"
      const name = typeof u.name === 'string' ? u.name.trim().slice(0, 40) : '';
      if (name && name !== s.name && !/^(unknown|n\/a|none|speaker)/i.test(name)) {
        s.name = name;
        changed = true;
      }
      s.confidence = Math.max(s.confidence, conf);
      s.source = source;
    }
    if (changed) version += 1;
    return changed;
  }

  function display(s) {
    const sameRole = [...speakers.values()].filter((x) => x.role === s.role);
    const isUser = s.channel === 'mic';
    let name = s.name;
    if (isUser) name = 'You';
    if (!name) name = ROLE_TITLE[s.role] + (sameRole.length > 1 ? ` ${s.label}` : '');
    return { name, roleTitle: ROLE_TITLE[s.role] };
  }

  function list() {
    return [...speakers.values()].map((s) => ({ ...s, ...display(s) }));
  }

  // Label used in prompts: role first so the model can reason about who asked what.
  function promptLabel(key) {
    const s = speakers.get(key);
    if (!s) return 'Speaker';
    const who = s.channel === 'mic' ? 'the app user' : s.name || `voice ${s.key}`;
    return `${ROLE_TITLE[s.role]} (${who})`;
  }

  function needsDetection() {
    const all = [...speakers.values()];
    // Only interviewer voices without a name are worth asking the AI about.
    return all.some((s) => s.channel === 'call' && !s.name && s.confidence < 0.8);
  }

  return {
    reset,
    resolve,
    get,
    apply,
    list,
    promptLabel,
    needsDetection,
    lastOn: (channel) => lastOnChannel[channel],
    get version() {
      return version;
    },
    get size() {
      return speakers.size;
    }
  };
}

module.exports = { createSpeakerRegistry, ROLE_TITLE };
