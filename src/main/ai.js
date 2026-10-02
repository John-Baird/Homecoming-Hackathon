// OpenAI Responses API calls: pre-call social research (with web search)
// and per-turn live analysis (technical answers + which social items matter now).
const API = 'https://api.openai.com/v1/responses';

async function callResponses(apiKey, body, { timeoutMs = 60000, reasoningEffort } = {}) {
  const payload = { ...body };
  if (reasoningEffort) payload.reasoning = { effort: reasoningEffort };

  const run = async (p) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(p),
        signal: ctrl.signal
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = (json.error && json.error.message) || `HTTP ${res.status}`;
        const err = new Error(msg);
        err.status = res.status;
        throw err;
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return await run(payload);
  } catch (e) {
    // Models without reasoning support reject the `reasoning` field: retry once without it.
    if (payload.reasoning && /reasoning/i.test(e.message)) {
      delete payload.reasoning;
      return run(payload);
    }
    throw e;
  }
}

function outputText(resp) {
  if (typeof resp.output_text === 'string' && resp.output_text) return resp.output_text;
  const parts = [];
  for (const item of resp.output || []) {
    if (item.type === 'message') {
      for (const c of item.content || []) if (c.type === 'output_text' && c.text) parts.push(c.text);
    }
  }
  return parts.join('\n');
}

function citations(resp) {
  const out = [];
  for (const item of resp.output || []) {
    if (item.type !== 'message') continue;
    for (const c of item.content || []) {
      for (const a of c.annotations || []) {
        if (a.type === 'url_citation' && a.url) out.push({ url: a.url, title: a.title || a.url });
      }
    }
  }
  const seen = new Set();
  return out.filter((c) => (seen.has(c.url) ? false : seen.add(c.url)));
}

// Pull the first balanced JSON object out of model text (handles ```json fences and prose).
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const src = fenced ? fenced[1] : text;
  const start = src.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(src.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/* ---------------- Social research ---------------- */

const RESEARCH_SHAPE = `{
  "interviewer": {
    "name": string, "headline": string, "summary": string,
    "posts": [ { "title": string, "summary": string, "date": string, "source": string, "url": string } ],
    "achievements": [ { "title": string, "detail": string, "url": string } ]
  },
  "company": {
    "name": string, "summary": string,
    "posts": [ { "title": string, "summary": string, "date": string, "source": string, "url": string } ],
    "achievements": [ { "title": string, "detail": string, "url": string } ]
  },
  "conversationStarters": [ string ]
}`;

async function research(settings, profile) {
  const who = [
    profile.interviewerName && `Interviewer: ${profile.interviewerName}`,
    profile.interviewerRole && `Their role: ${profile.interviewerRole}`,
    profile.interviewerLinkedin && `Their LinkedIn: ${profile.interviewerLinkedin}`,
    profile.company && `Company: ${profile.company}`,
    profile.companyUrl && `Company website: ${profile.companyUrl}`,
    profile.jobTitle && `Role being interviewed for: ${profile.jobTitle}`
  ]
    .filter(Boolean)
    .join('\n');

  const today = new Date().toISOString().slice(0, 10);
  const input = `Today is ${today}. I have a job interview soon. Research the interviewer and the company using web search.

${who}

Find:
1. The interviewer's most recent public posts, articles, talks or interviews (LinkedIn, X, blogs, podcasts, conference talks) — newest first, up to 5.
2. The interviewer's biggest notable career achievements — up to 4.
3. The company's most recent posts, announcements, launches or news — newest first, up to 5.
4. The company's biggest achievements or milestones (funding, launches, awards, acquisitions, major customers) — up to 4.
5. Up to 4 short, natural conversation starters or questions I could ask that connect to what you found.

Rules:
- Only include items you actually found, each with the URL you found it at. Never invent posts, dates or achievements. If you are not confident an item is about THIS person (common names), leave it out.
- Keep each summary to one or two sentences, written so I can glance at it mid-conversation.
- Dates as YYYY-MM-DD when known, otherwise "".
- Reply with ONLY a JSON object of this shape, no prose:
${RESEARCH_SHAPE}`;

  const resp = await callResponses(
    settings.openaiKey,
    { model: settings.researchModel, tools: [{ type: 'web_search' }], input },
    { timeoutMs: 180000, reasoningEffort: settings.reasoningEffort || undefined }
  );

  const text = outputText(resp);
  const data = extractJson(text);
  if (!data) throw new Error('Research came back in an unexpected format. Try again, or try a different research model.');
  return normalizeResearch(data, profile, citations(resp));
}

function normalizeResearch(data, profile, cites = []) {
  const arr = (x) => (Array.isArray(x) ? x : []);
  const str = (x) => (typeof x === 'string' ? x.trim() : '');
  let n = 0;
  const post = (p, group) => ({
    id: `${group}-p${++n}`,
    group,
    kind: 'post',
    title: str(p.title),
    summary: str(p.summary),
    date: str(p.date),
    source: str(p.source),
    url: str(p.url)
  });
  const ach = (a, group) => ({
    id: `${group}-a${++n}`,
    group,
    kind: 'achievement',
    title: str(a.title),
    detail: str(a.detail),
    url: str(a.url)
  });
  const i = data.interviewer || {};
  const c = data.company || {};
  return {
    at: new Date().toISOString(),
    interviewer: {
      name: str(i.name) || profile.interviewerName,
      headline: str(i.headline) || profile.interviewerRole,
      summary: str(i.summary),
      posts: arr(i.posts).map((p) => post(p, 'interviewer')).filter((p) => p.title || p.summary),
      achievements: arr(i.achievements).map((a) => ach(a, 'interviewer')).filter((a) => a.title)
    },
    company: {
      name: str(c.name) || profile.company,
      summary: str(c.summary),
      posts: arr(c.posts).map((p) => post(p, 'company')).filter((p) => p.title || p.summary),
      achievements: arr(c.achievements).map((a) => ach(a, 'company')).filter((a) => a.title)
    },
    conversationStarters: arr(data.conversationStarters).map(str).filter(Boolean).slice(0, 6),
    sources: cites.slice(0, 20)
  };
}

function socialItems(r) {
  if (!r) return [];
  return [...r.interviewer.posts, ...r.interviewer.achievements, ...r.company.posts, ...r.company.achievements];
}

/* ---------------- Live analysis ---------------- */

const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['technical', 'social'],
  properties: {
    technical: {
      type: 'object',
      additionalProperties: false,
      required: ['detected', 'question', 'answer', 'points', 'code'],
      properties: {
        detected: { type: 'boolean' },
        question: { type: 'string' },
        answer: { type: 'string' },
        points: { type: 'array', items: { type: 'string' } },
        code: { type: 'string' }
      }
    },
    social: {
      type: 'object',
      additionalProperties: false,
      required: ['relevant_ids', 'tip'],
      properties: {
        relevant_ids: { type: 'array', items: { type: 'string' } },
        tip: { type: 'string' }
      }
    }
  }
};

function formatTranscript(turns) {
  return turns.map((t) => `${t.label || (t.speaker === 'you' ? 'Candidate' : 'Interviewer')}: ${t.text}`).join('\n');
}

function contextBlock(profile) {
  return [
    profile.jobTitle && `Role: ${profile.jobTitle}`,
    profile.company && `Company: ${profile.company}`,
    profile.jobDescription && `Job description:\n${profile.jobDescription.slice(0, 3000)}`,
    profile.myBackground && `Candidate background:\n${profile.myBackground.slice(0, 3000)}`
  ]
    .filter(Boolean)
    .join('\n\n');
}

const SYSTEM = `You are a discreet real-time assistant for a job candidate during a live video interview.
You see the latest transcript. Each line is labelled with the speaker's detected role (Interviewer / Candidate / Other);
"the app user" is the person you are helping.
Decide two things:

TECHNICAL — set detected=true only if an Interviewer's most recent turn(s) ask or probe a technical question
(engineering, system design, coding, data, product/technical domain knowledge) that is NOT already in the
"already answered" list. Then:
- question: the question in a short clean form.
- answer: 2-4 sentences the candidate could say out loud, plain spoken language, concrete, correct.
- points: 3-5 short talking points or follow-ups (each under 15 words).
- code: a short code snippet only if the question is explicitly about code, else "".
Tailor to the candidate's background when it helps. Never fabricate facts about the candidate.
If not detected, return empty strings and an empty array.

SOCIAL — from the research items list, return relevant_ids for items (max 2) that would genuinely help the
candidate RIGHT NOW (e.g. topic overlap with what's being discussed, "do you have questions for us",
small talk about the company or the interviewer's work). tip: one sentence on how to use it naturally.
Return an empty list and "" when nothing is clearly useful. Be selective: false alarms are distracting.`;

async function analyze(settings, { profile, turns, research: r, answered, manualQuestion }) {
  const items = socialItems(r).map((it) => {
    const body = it.kind === 'post' ? it.summary : it.detail;
    return `${it.id} | ${it.group} ${it.kind} | ${it.title}${body ? ' — ' + body : ''}`;
  });

  const user = [
    contextBlock(profile) || 'No extra context provided.',
    `Research items (id | type | text):\n${items.length ? items.join('\n') : '(none)'}`,
    `Already answered technical questions:\n${answered.length ? answered.map((q) => '- ' + q).join('\n') : '(none)'}`,
    `Transcript (most recent last):\n${formatTranscript(turns) || '(nothing yet)'}`,
    manualQuestion
      ? `The candidate typed this question privately and wants an answer now (treat as technical, detected=true): ${manualQuestion}`
      : ''
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');

  const resp = await callResponses(
    settings.openaiKey,
    {
      model: settings.liveModel,
      instructions: SYSTEM,
      input: user,
      text: { format: { type: 'json_schema', name: 'copilot_analysis', schema: ANALYSIS_SCHEMA, strict: true } }
    },
    { timeoutMs: 45000, reasoningEffort: settings.reasoningEffort || undefined }
  );

  const parsed = extractJson(outputText(resp));
  if (!parsed) throw new Error('Live analysis returned an unexpected format');
  const valid = new Set(socialItems(r).map((x) => x.id));
  const t = parsed.technical || {};
  const s = parsed.social || {};
  return {
    technical: {
      detected: !!t.detected && !!(t.question || '').trim(),
      question: (t.question || '').trim(),
      answer: (t.answer || '').trim(),
      points: Array.isArray(t.points) ? t.points.filter((p) => typeof p === 'string' && p.trim()).slice(0, 6) : [],
      code: (t.code || '').trim()
    },
    social: {
      relevantIds: (Array.isArray(s.relevant_ids) ? s.relevant_ids : []).filter((id) => valid.has(id)).slice(0, 2),
      tip: (s.tip || '').trim()
    }
  };
}

/* ---------------- Speaker role detection ---------------- */

const ROLES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['speakers'],
  properties: {
    speakers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'role', 'name', 'confidence'],
        properties: {
          key: { type: 'string' },
          role: { type: 'string', enum: ['interviewer', 'candidate', 'other', 'unknown'] },
          name: { type: 'string' },
          confidence: { type: 'number' }
        }
      }
    }
  }
};

const ROLES_SYSTEM = `You identify the interviewers' names in a live job-interview call transcript.
Each line starts with a voice key in brackets. "mic:" is the candidate using this app (ignore it).
"call:A", "call:B", … are separate interviewer-side voices from the call audio.

For every call voice key, return:
- role: always "interviewer".
- name: the person's first name (or full name) only if it is clearly stated or used in the conversation
  ("Hi, I'm Jordan", "thanks, Priya", "I'll hand over to Sam"), or if they clearly match the expected
  interviewer name. Otherwise "".
- confidence: 0 to 1 that the name is right (0 when name is "").`

async function detectRoles(settings, { turns, keys, profile }) {
  const user = [
    profile && profile.interviewerName ? `Expected interviewer: ${profile.interviewerName}${profile.interviewerRole ? ' (' + profile.interviewerRole + ')' : ''}` : '',
    profile && profile.company ? `Company: ${profile.company}` : '',
    `Voice keys: ${keys.join(', ')}`,
    'Transcript (oldest first):',
    turns.map((t) => `[${t.speakerKey}] ${t.text}`).join('\n')
  ]
    .filter(Boolean)
    .join('\n');

  const resp = await callResponses(
    settings.openaiKey,
    {
      model: settings.liveModel,
      instructions: ROLES_SYSTEM,
      input: user,
      text: { format: { type: 'json_schema', name: 'speaker_roles', schema: ROLES_SCHEMA, strict: true } }
    },
    { timeoutMs: 30000, reasoningEffort: settings.reasoningEffort || undefined }
  );
  const parsed = extractJson(outputText(resp));
  if (!parsed || !Array.isArray(parsed.speakers)) throw new Error('Role detection returned an unexpected format');
  const valid = new Set(keys);
  return parsed.speakers
    .filter((s) => s && valid.has(s.key))
    .map((s) => ({
      key: s.key,
      role: s.role,
      name: typeof s.name === 'string' ? s.name.trim() : '',
      confidence: Math.max(0, Math.min(1, Number(s.confidence) || 0))
    }));
}

async function testKey(apiKey, model) {
  await callResponses(apiKey, { model, input: 'Reply with OK.', max_output_tokens: 16 }, { timeoutMs: 20000 });
  return true;
}

module.exports = { research, analyze, detectRoles, testKey, extractJson, normalizeResearch, socialItems };
