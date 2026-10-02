// Demo mode (npm run demo): plays a scripted conversation through the real overlay
// without any API keys or audio, so you can check placement and behaviour.
const DEMO_RESEARCH = {
  at: new Date().toISOString(),
  interviewer: {
    name: 'Demo Interviewer',
    headline: 'Engineering Manager · Demo Co',
    summary: 'Sample data — run real research from the Interview screen.',
    posts: [
      { id: 'interviewer-p1', group: 'interviewer', kind: 'post', title: 'Why we moved to event streaming', summary: 'Sample post about migrating batch jobs to an event pipeline.', date: '', source: 'LinkedIn', url: '' },
      { id: 'interviewer-p2', group: 'interviewer', kind: 'post', title: 'Hiring for platform roles', summary: 'Sample thread on what they look for in platform engineers.', date: '', source: 'X', url: '' }
    ],
    achievements: [{ id: 'interviewer-a3', group: 'interviewer', kind: 'achievement', title: 'Led the public API launch', detail: 'Sample achievement.', url: '' }]
  },
  company: {
    name: 'Demo Co',
    summary: 'Sample company used by demo mode.',
    posts: [{ id: 'company-p4', group: 'company', kind: 'post', title: 'Launch announcement', summary: 'Sample product launch post.', date: '', source: 'Company blog', url: '' }],
    achievements: [{ id: 'company-a5', group: 'company', kind: 'achievement', title: 'Series B', detail: 'Sample milestone.', url: '' }]
  },
  conversationStarters: ['How has the launch changed what the team is prioritizing?'],
  sources: []
};

const SCRIPT = [
  { speaker: 'call', text: "Hi, I'm Jordan — thanks for making the time. I saw you've done a lot with real-time systems, walk me through that.", roles: [{ key: 'call:A', role: 'interviewer', name: 'Jordan', confidence: 0.95 }], social: { relevantIds: ['interviewer-p1'], tip: 'They wrote about event streaming — connect it to your pipeline work.' } },
  { speaker: 'mic', text: 'Sure. At my last role I owned the event pipeline that fed our live dashboards.', roles: [{ key: 'mic:A', role: 'candidate', name: '', confidence: 0.95 }] },
  {
    speaker: 'call',
    text: "Let's go deeper — how would you design a rate limiter for a public API?",
    technical: {
      question: 'How would you design a rate limiter for a public API?',
      answer: 'Use a token bucket per API key: tokens refill at a fixed rate and the bucket size caps bursts. Keep counters in a shared store like Redis and update them atomically so every server sees the same count.',
      points: ['Clarify the key: per user, per API key, or per IP?', 'Reject with HTTP 429 and a Retry-After header', 'Sliding window counters avoid bursts at window edges'],
      code: ''
    }
  },
  { speaker: 'mic', text: "I'd start by clarifying what we're limiting on — per key, per user, or per IP." },
  { speaker: 'call', text: "We're about out of time — any questions for us?", social: { relevantIds: ['company-p4'], tip: 'Ask how the recent launch changed team priorities.' } }
];

function runDemo({ onPartial, onFinal, onTechnical, onSocial, onRoles }) {
  let i = 0;
  let stopped = false;
  const timers = [];
  const later = (ms, fn) => timers.push(setTimeout(() => !stopped && fn(), ms));

  function step() {
    if (stopped) return;
    const line = SCRIPT[i % SCRIPT.length];
    const words = line.text.split(' ');
    words.forEach((_, w) => later(w * 90, () => onPartial(line.speaker, words.slice(0, w + 1).join(' '))));
    later(words.length * 90 + 300, () => {
      onFinal(line.speaker, line.text);
      if (line.roles && onRoles) later(600, () => onRoles(line.roles));
      if (line.technical) later(900, () => onTechnical(line.technical));
      if (line.social) later(700, () => onSocial(line.social));
    });
    i += 1;
    later(words.length * 90 + 4500, step);
  }
  later(800, step);
  return () => {
    stopped = true;
    timers.forEach(clearTimeout);
  };
}

module.exports = { runDemo, DEMO_RESEARCH };
