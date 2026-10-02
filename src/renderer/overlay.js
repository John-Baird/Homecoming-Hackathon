// Overlay renderer: tabs, pings, panels, transcript. All untrusted text goes through textContent.
(function () {
  const api = window.copilot;
  const $ = (id) => document.getElementById(id);

  const ui = {
    open: null, // 'social' | 'technical' | null
    unseen: { social: 0, technical: 0 },
    turns: [],
    partial: { mic: null, call: null }, // { speakerKey, text }
    speakers: {}, // key -> { name, roleTitle, role, channel }
    lastSpeaker: { mic: null, call: null },
    mode: 'live',
    technical: [],
    social: { relevantIds: [], tip: '' },
    research: null,
    paused: false,
    running: false,
    showTranscript: true,
    levels: { mic: 0, call: 0 },
    lastLoud: { mic: 0, call: 0 }
  };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  /* ---------- Click-through handling ---------- */
  let interactive = false;
  function setInteractive(on) {
    if (on === interactive) return;
    interactive = on;
    api.send('overlay:interactive', on);
  }
  window.addEventListener('mousemove', (e) => {
    const t = document.elementFromPoint(e.clientX, e.clientY);
    setInteractive(!!(t && t.closest('.hit')));
  });
  document.addEventListener('mouseleave', () => setInteractive(false));

  /* ---------- Tabs, badges, toast ---------- */
  function setOpen(tab) {
    ui.open = tab;
    $('panelSocial').classList.toggle('hidden', tab !== 'social');
    $('panelTechnical').classList.toggle('hidden', tab !== 'technical');
    $('tabSocial').classList.toggle('active', tab === 'social');
    $('tabTechnical').classList.toggle('active', tab === 'technical');
    document.body.classList.toggle('panel-open', !!tab);
    if (tab) {
      ui.unseen[tab] = 0;
      hideToast();
    }
    renderBadges();
    if (tab === 'technical') setTimeout(() => $('askInput').focus({ preventScroll: true }), 50);
  }

  function renderBadges() {
    for (const [tab, id] of [['social', 'badgeSocial'], ['technical', 'badgeTechnical']]) {
      const n = ui.unseen[tab];
      $(id).classList.toggle('hidden', n === 0);
      $(id).querySelector('.num').textContent = n > 9 ? '9+' : String(n);
    }
  }

  let toastTimer = null;
  let toastTab = null;
  function ping(tab, text) {
    if (ui.open === tab) return;
    ui.unseen[tab] += 1;
    renderBadges();
    toastTab = tab;
    const toast = $('toast');
    const tabEl = tab === 'social' ? $('tabSocial') : $('tabTechnical');
    const r = tabEl.getBoundingClientRect();
    toast.style.top = Math.max(14, r.top + 10) + 'px';
    $('toastKicker').textContent = (tab === 'social' ? 'Social' : 'Technical') + ' · may help now';
    $('toastKicker').style.color = tab === 'social' ? 'var(--social)' : 'var(--tech-soft)';
    $('toastText').textContent = text;
    toast.classList.remove('hidden');
    // restart the entry animation
    toast.style.animation = 'none';
    void toast.offsetWidth;
    toast.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 5000);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    $('toast').classList.add('hidden');
  }

  $('tabSocial').addEventListener('click', () => setOpen(ui.open === 'social' ? null : 'social'));
  $('tabTechnical').addEventListener('click', () => setOpen(ui.open === 'technical' ? null : 'technical'));
  $('toast').addEventListener('click', () => toastTab && setOpen(toastTab));
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => setOpen(null)));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(null);
  });

  /* ---------- Demo / Live switch ---------- */
  function renderMode() {
    $('modeDemo').classList.toggle('on', ui.mode === 'demo');
    $('modeLive').classList.toggle('on', ui.mode === 'live');
    $('modeDemo').setAttribute('aria-pressed', String(ui.mode === 'demo'));
    $('modeLive').setAttribute('aria-pressed', String(ui.mode === 'live'));
    document.body.classList.toggle('demo-mode', ui.mode === 'demo');
  }
  async function switchMode(mode) {
    if (mode === ui.mode || busy) return;
    busy = true;
    try {
      const r = await api.invoke('mode:set', mode);
      if (r && r.warning) renderStatus({ ...lastStatus, message: r.warning });
    } finally {
      busy = false;
    }
  }
  $('modeDemo').addEventListener('click', () => switchMode('demo'));
  $('modeLive').addEventListener('click', () => switchMode('live'));

  /* ---------- Status pill ---------- */
  /* ---------- Start / stop / pause ---------- */
  let busy = false;
  $('btnRun').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    try {
      if (ui.running) {
        await api.invoke('session:stop');
        ui.running = false;
        ui.paused = false;
      } else {
        const r = await api.invoke('session:start');
        if (r && r.ok === false) renderStatus({ ...lastStatus, message: r.error });
      }
    } finally {
      busy = false;
      renderControls();
    }
  });
  $('btnPause').addEventListener('click', async () => {
    if (!ui.running) return;
    const r = await api.invoke('session:pause', !ui.paused);
    ui.paused = r.paused;
    renderControls();
    renderStatus();
  });

  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M9 5v14M15 5v14"/></svg>'
  };
  let renderedControls = '';
  function renderControls() {
    const key = `${ui.running}|${ui.paused}`;
    if (key === renderedControls) return;
    renderedControls = key;
    const run = $('btnRun');
    run.className = 'ctl ' + (ui.running ? 'stop' : 'start');
    run.innerHTML = (ui.running ? ICON.stop : ICON.play) + `<span class="ctl-label">${ui.running ? 'Stop' : 'Start'}</span>`;
    run.setAttribute('aria-label', ui.running ? 'Stop listening' : 'Start listening');
    const pause = $('btnPause');
    pause.disabled = !ui.running;
    pause.className = 'ctl' + (ui.running && ui.paused ? ' resume' : '');
    pause.innerHTML = (ui.paused ? ICON.play : ICON.pause) + `<span class="ctl-label">${ui.paused ? 'Resume' : 'Pause'}</span>`;
    pause.setAttribute('aria-label', ui.paused ? 'Resume listening' : 'Pause listening');
  }
  $('btnTranscript').addEventListener('click', () => {
    ui.showTranscript = !ui.showTranscript;
    $('transcript').classList.toggle('hidden', !ui.showTranscript);
    $('btnTranscript').classList.toggle('on', ui.showTranscript);
  });
  $('btnSetup').addEventListener('click', () => api.send('app:openSetup'));
  $('error').addEventListener('click', () => {
    lastStatus = { ...lastStatus, message: '' };
    $('error').classList.add('hidden');
    setInteractive(false);
  });

  let lastStatus = {};
  function renderStatus(s) {
    if (s) lastStatus = s;
    s = lastStatus;
    const now = Date.now();
    const micTalking = now - ui.lastLoud.mic < 600;
    const callTalking = now - ui.lastLoud.call < 600;
    let text = 'Listening';
    if (!ui.running) text = 'Stopped';
    else if (ui.paused) text = 'Paused';
    else if (s.mic === 'connecting' || s.call === 'connecting') text = 'Connecting…';
    else if (s.mic === 'reconnecting' || s.call === 'reconnecting') text = 'Reconnecting…';
    else if (callTalking && micTalking) text = 'Both speaking';
    else if (callTalking) text = speakerName(ui.lastSpeaker.call, 'Interviewer') + ' speaking';
    else if (micTalking) text = speakerName(ui.lastSpeaker.mic, 'You') + ' speaking';
    $('statusText').textContent = text;
    $('aiText').textContent = s.ai === 'thinking' ? 'Thinking…' : s.ai === 'error' ? 'AI issue' : 'Ready';
    $('bars').classList.toggle('paused', ui.paused);
    renderControls();
    const err = $('error');
    if (s.message) {
      if (err.textContent !== s.message) err.textContent = s.message;
      err.classList.remove('hidden');
    } else {
      err.classList.add('hidden');
    }
  }

  // Level meter: bars follow whichever speaker is loudest.
  function onLevel(channel, rms) {
    ui.levels[channel] = rms;
    if (rms > 0.02) ui.lastLoud[channel] = Date.now();
  }
  setInterval(() => {
    const lv = Math.max(ui.levels.mic, ui.levels.call);
    const bars = $('bars').children;
    const color = ui.levels.call > ui.levels.mic ? 'var(--them)' : 'var(--you)';
    for (let i = 0; i < bars.length; i++) {
      const jitter = 0.7 + 0.3 * Math.sin(Date.now() / 90 + i * 2);
      bars[i].style.transform = `scaleY(${ui.paused ? 0.3 : Math.min(1, 0.3 + lv * 12 * jitter)})`;
      if (!ui.paused) bars[i].style.background = color;
    }
    renderStatus();
  }, 120);

  /* ---------- Speakers + transcript ---------- */
  function speakerInfo(key) {
    return key ? ui.speakers[key] : null;
  }
  function speakerName(key, fallback) {
    const sp = speakerInfo(key);
    return sp ? sp.name : fallback;
  }
  // Mic = you (interviewee); call audio = interviewer side.
  function roleClass(sp, channel) {
    return (sp ? sp.channel : channel) === 'mic' ? 'you' : 'interviewer';
  }

  // Who's who, shown in the transcript header: "Jordan · Interviewer   You · Candidate"
  function renderSpeakers() {
    const box = $('txSpeakers');
    box.textContent = '';
    const list = Object.values(ui.speakers).sort((a, b) => (a.channel === 'call' ? -1 : 1) - (b.channel === 'call' ? -1 : 1) || a.key.localeCompare(b.key));
    if (!list.length) {
      box.appendChild(el('span', '', ui.running ? 'Detecting speakers…' : ''));
      return;
    }
    list.forEach((sp) => {
      const chip = el('span', 'who-chip ' + roleClass(sp));
      chip.appendChild(el('span', 'who-name', sp.name));
      if (sp.channel === 'call' && sp.name !== sp.roleTitle && !sp.name.startsWith('Interviewer')) chip.appendChild(el('span', 'who-role', 'Interviewer'));
      box.appendChild(chip);
    });
  }

  function renderTranscript() {
    const box = $('txLines');
    box.textContent = '';
    const lines = ui.turns.slice(-3).map((t) => ({ key: t.speakerKey, channel: t.channel, text: t.text, partial: false }));
    for (const ch of ['call', 'mic']) {
      const p = ui.partial[ch];
      if (p && p.text) lines.push({ key: p.speakerKey, channel: ch, text: p.text, partial: true });
    }
    const show = lines.slice(-3);
    if (!show.length) {
      const row = el('div', 'tx');
      row.appendChild(el('span', 'tx-text muted', ui.running ? 'Waiting for someone to speak…' : 'Press Start to begin listening.'));
      box.appendChild(row);
      return;
    }
    show.forEach((l, i) => {
      const sp = speakerInfo(l.key);
      const row = el('div', 'tx' + (i < show.length - 1 ? ' old' : '') + (l.partial ? ' partial' : ''));
      const who = el('span', 'tx-who ' + roleClass(sp, l.channel));
      who.appendChild(el('span', 'tx-name', sp ? sp.name : l.channel === 'mic' ? 'You' : 'Interviewer'));
      if (sp && sp.channel === 'call' && !sp.name.startsWith('Interviewer')) who.appendChild(el('span', 'tx-role', 'Interviewer'));
      row.appendChild(who);
      row.appendChild(el('span', 'tx-text', l.text));
      box.appendChild(row);
    });
  }

  function setSpeakers(list) {
    ui.speakers = {};
    (list || []).forEach((sp) => (ui.speakers[sp.key] = sp));
    renderSpeakers();
    renderTranscript();
  }

  /* ---------- Technical panel ---------- */
  function timeAgo(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    return m + ' min ago';
  }

  function renderTechnical() {
    const body = $('techBody');
    body.textContent = '';
    if (!ui.technical.length) {
      body.appendChild(el('div', 'empty', 'Listening for technical questions. Answers appear here — and the tab pings — as soon as the interviewer asks one. You can also ask privately above.'));
      return;
    }
    const latestId = ui.technical[ui.technical.length - 1].id;
    [...ui.technical].reverse().forEach((c) => {
      const card = el('div', 'card t' + (c.id === latestId ? ' relevant' : ''));
      const meta = el('div', 'card-meta');
      meta.appendChild(el('span', '', (c.manual ? 'You asked · ' : 'Detected · ') + timeAgo(c.at)));
      if (c.id === latestId) meta.appendChild(el('span', 'rel-chip', 'Relevant now'));
      card.appendChild(meta);
      card.appendChild(el('div', 'tq', '“' + c.question + '”'));
      if (c.answer) card.appendChild(el('div', 'card-text', c.answer));
      if (c.code) card.appendChild(el('pre', 'code', c.code));
      if (c.points && c.points.length) {
        const pts = el('div', 'points');
        pts.appendChild(el('div', 'points-label', 'Talking points'));
        c.points.forEach((p) => {
          const row = el('div', 'point');
          row.appendChild(el('span', 'arrow', '→'));
          row.appendChild(el('span', '', p));
          pts.appendChild(row);
        });
        card.appendChild(pts);
      }
      body.appendChild(card);
    });
  }

  $('askForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('askInput').value.trim();
    if (!q) return;
    $('askInput').value = '';
    $('askInput').placeholder = 'Thinking…';
    await api.invoke('session:ask', q);
    $('askInput').placeholder = 'Ask privately… (only you see this)';
  });

  /* ---------- Social panel ---------- */
  function initials(name) {
    return (name || '?')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join('');
  }

  function linkOrNull(url, label) {
    if (!url || !/^https?:\/\//i.test(url)) return null;
    const a = el('a', '', label || 'Source ↗');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  function itemCard(it) {
    const rel = ui.social.relevantIds.includes(it.id);
    const card = el('div', 'card s' + (rel ? ' relevant' : ''));
    const meta = el('div', 'card-meta');
    const metaText = [it.source, it.date].filter(Boolean).join(' · ') || (it.kind === 'achievement' ? 'Achievement' : 'Post');
    meta.appendChild(el('span', '', metaText));
    if (rel) meta.appendChild(el('span', 'rel-chip', 'Relevant now'));
    card.appendChild(meta);
    if (it.title) card.appendChild(el('div', 'card-title', it.title));
    const body = it.kind === 'post' ? it.summary : it.detail;
    if (body) card.appendChild(el('div', 'card-text', body));
    if (rel && ui.social.tip) card.appendChild(el('div', 'tip', ui.social.tip));
    const a = linkOrNull(it.url);
    if (a) card.appendChild(a);
    return card;
  }

  function section(title, items) {
    const s = el('div', 'section');
    s.appendChild(el('h3', '', title));
    if (!items.length) s.appendChild(el('div', 'card-text muted', 'Nothing found.'));
    // relevant items float to the top
    const sorted = [...items].sort((a, b) => ui.social.relevantIds.includes(b.id) - ui.social.relevantIds.includes(a.id));
    sorted.forEach((it) => s.appendChild(itemCard(it)));
    return s;
  }

  function renderSocial() {
    const body = $('socialBody');
    body.textContent = '';
    const r = ui.research;
    if (!r) {
      body.appendChild(el('div', 'empty', 'No research yet. Open Setup (gear icon), enter the interviewer and company, and run research before the call.'));
      return;
    }

    const person = el('div', 'person');
    person.appendChild(el('div', 'avatar', initials(r.interviewer.name)));
    const pc = el('div');
    pc.appendChild(el('div', 'person-name', r.interviewer.name || 'Interviewer'));
    if (r.interviewer.headline) pc.appendChild(el('div', 'person-sub', r.interviewer.headline));
    person.appendChild(pc);
    body.appendChild(person);
    if (r.interviewer.summary) body.appendChild(el('div', 'card-text', r.interviewer.summary));

    body.appendChild(section('Interviewer · latest posts', r.interviewer.posts));
    body.appendChild(section('Interviewer · big achievements', r.interviewer.achievements));
    body.appendChild(el('div', 'divider'));

    const co = el('div', 'person');
    co.appendChild(el('div', 'avatar square', initials(r.company.name)));
    const cc = el('div');
    cc.appendChild(el('div', 'person-name', r.company.name || 'Company'));
    if (r.company.summary) cc.appendChild(el('div', 'person-sub', r.company.summary));
    co.appendChild(cc);
    body.appendChild(co);

    body.appendChild(section('Company · latest posts', r.company.posts));
    body.appendChild(section('Company · big achievements', r.company.achievements));

    if (r.conversationStarters && r.conversationStarters.length) {
      const s = el('div', 'section');
      s.appendChild(el('h3', '', 'Questions you could ask'));
      r.conversationStarters.forEach((q) => {
        const row = el('div', 'bullet');
        row.appendChild(el('span', 'dot', '◆'));
        row.appendChild(el('span', '', q));
        s.appendChild(row);
      });
      body.appendChild(s);
    }
  }

  function findItem(id) {
    const r = ui.research;
    if (!r) return null;
    return [...r.interviewer.posts, ...r.interviewer.achievements, ...r.company.posts, ...r.company.achievements].find((x) => x.id === id);
  }

  /* ---------- Events from main ---------- */
  function applySettings(s) {
    if (!s) return;
    document.documentElement.style.setProperty('--glass-a', String(s.glassOpacity ?? 0.55));
    ui.showTranscript = s.showTranscript !== false;
    $('transcript').classList.toggle('hidden', !ui.showTranscript);
    $('btnTranscript').classList.toggle('on', ui.showTranscript);
  }

  // Load a full snapshot from main (start of a session, or after a demo/live reset).
  function loadSnapshot(snap) {
    ui.mode = snap.mode || ui.mode;
    ui.turns = snap.turns || [];
    ui.partial = snap.partial || { mic: null, call: null };
    ui.technical = snap.technical || [];
    ui.social = snap.social || { relevantIds: [], tip: '' };
    ui.research = snap.research || null;
    ui.paused = !!snap.paused;
    ui.running = !!snap.running;
    ui.lastSpeaker = { mic: null, call: null };
    ui.levels = { mic: 0, call: 0 };
    ui.lastLoud = { mic: 0, call: 0 };
    ui.unseen = { social: 0, technical: 0 };
    hideToast();
    applySettings(snap.settings);
    setSpeakers(snap.speakers);
    renderMode();
    renderStatus(snap.status);
    renderTranscript();
    renderTechnical();
    renderSocial();
    setOpen(null);
  }

  api.on('session:begin', async (p) => {
    loadSnapshot(p.snapshot);
    if (p.demo) return;
    await window.CopilotAudio.start({
      sampleRate: p.sampleRate,
      micDeviceId: p.micDeviceId,
      interviewerSource: p.interviewerSource,
      onLevel
    });
  });

  // Demo <-> Live switch: everything starts over.
  api.on('session:reset', (snap) => {
    window.CopilotAudio.stop();
    loadSnapshot(snap);
  });

  api.on('session:end', () => {
    window.CopilotAudio.stop();
    ui.running = false;
    ui.paused = false;
    ui.partial = { mic: null, call: null };
    ui.levels = { mic: 0, call: 0 };
    renderControls();
    renderTranscript();
    renderSpeakers();
  });
  api.on('status', (s) => {
    ui.paused = !!s.paused;
    if (typeof s.running === 'boolean') ui.running = s.running;
    if (s.mode && s.mode !== ui.mode) {
      ui.mode = s.mode;
      renderMode();
    }
    renderStatus(s);
  });
  api.on('settings', applySettings);
  api.on('speakers', setSpeakers);

  api.on('transcript:partial', ({ channel, partial }) => {
    ui.partial[channel] = partial;
    if (partial) ui.lastSpeaker[channel] = partial.speakerKey;
    renderTranscript();
  });
  api.on('transcript:final', ({ turn }) => {
    const i = ui.turns.findIndex((t) => t.id === turn.id);
    if (i >= 0) ui.turns[i] = turn;
    else ui.turns.push(turn);
    if (ui.turns.length > 60) ui.turns.shift();
    ui.partial[turn.channel] = null;
    ui.lastSpeaker[turn.channel] = turn.speakerKey;
    renderTranscript();
  });

  api.on('technical:card', (card) => {
    ui.technical.push(card);
    renderTechnical();
    ping('technical', card.question);
  });

  api.on('social:relevant', (s) => {
    ui.social = s;
    renderSocial();
    const first = findItem(s.relevantIds[0]);
    ping('social', s.tip || (first && first.title) || 'Something from your research fits this moment');
  });

  api.on('research', (r) => {
    ui.research = r;
    renderSocial();
  });

  api.on('hotkey', ({ tab }) => setOpen(tab && ui.open === tab ? null : tab));

  // keep "x min ago" fresh
  setInterval(() => ui.open === 'technical' && renderTechnical(), 30000);

  renderMode();
  renderTranscript();
  renderTechnical();
  renderSocial();
  renderBadges();
  // Pick up the current mode/state even before a session starts.
  api.invoke('session:snapshot').then(loadSnapshot).catch(() => {});
})();
