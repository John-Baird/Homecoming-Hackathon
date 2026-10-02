// Setup window: interview details, research, settings, device selection.
(function () {
  const api = window.copilot;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };

  if (api.platform === 'darwin') {
    $('modKey').textContent = 'Cmd';
    document.querySelectorAll('.mk').forEach((k) => (k.textContent = 'Cmd'));
  }

  /* ---------- Navigation ---------- */
  document.querySelectorAll('.nav').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.nav').forEach((x) => x.classList.toggle('active', x === b));
      $('view-interview').classList.toggle('hidden', b.dataset.view !== 'interview');
      $('view-settings').classList.toggle('hidden', b.dataset.view !== 'settings');
    })
  );
  function goSettings() {
    document.querySelector('.nav[data-view="settings"]').click();
  }

  /* ---------- Profile (autosaves) ---------- */
  const profileFields = [...document.querySelectorAll('[data-profile]')];
  let profileTimer = null;
  function collectProfile() {
    const p = {};
    profileFields.forEach((f) => (p[f.id] = f.value));
    return p;
  }
  profileFields.forEach((f) =>
    f.addEventListener('input', () => {
      clearTimeout(profileTimer);
      profileTimer = setTimeout(() => api.invoke('profile:set', collectProfile()), 400);
    })
  );

  /* ---------- Settings ---------- */
  const settingFields = [...document.querySelectorAll('[data-setting]')];
  let current = null;

  function fillSettings(s) {
    current = s;
    settingFields.forEach((f) => {
      const v = s[f.id];
      if (f.type === 'checkbox') f.checked = !!v;
      else if (f.tagName === 'SELECT') f.dataset.want = v ?? '';
      else f.value = v ?? '';
    });
    ['transcriptionProvider', 'reasoningEffort'].forEach((id) => ($(id).value = s[id] ?? ''));
    $('openaiKeyHint').textContent = s.openaiKeySet ? `Saved (${s.openaiKeyHint}). Leave blank to keep it.` : 'Not set.';
    $('assemblyaiKeyHint').textContent = s.assemblyaiKeySet ? `Saved (${s.assemblyaiKeyHint}). Leave blank to keep it.` : 'Not set.';
    $('glassVal').textContent = Math.round((s.glassOpacity ?? 0.55) * 100) + '%';
  }

  function collectSettings() {
    const out = {};
    settingFields.forEach((f) => {
      if (f.type === 'checkbox') out[f.id] = f.checked;
      else if (f.type === 'number' || f.type === 'range') out[f.id] = Number(f.value);
      else out[f.id] = f.value;
    });
    const ok = $('openaiKey').value.trim();
    const ak = $('assemblyaiKey').value.trim();
    if (ok) out.openaiKey = ok;
    if (ak) out.assemblyaiKey = ak;
    return out;
  }

  async function saveSettings() {
    const s = await api.invoke('settings:set', collectSettings());
    $('openaiKey').value = '';
    $('assemblyaiKey').value = '';
    fillSettings(s);
    await loadDevices(false);
    $('saveState').textContent = 'Saved';
    setTimeout(() => ($('saveState').textContent = ''), 2000);
    return s;
  }
  $('btnSave').addEventListener('click', saveSettings);
  $('glassOpacity').addEventListener('input', () => ($('glassVal').textContent = Math.round($('glassOpacity').value * 100) + '%'));

  $('btnTestOpenAI').addEventListener('click', async () => {
    await saveSettings();
    $('openaiKeyHint').textContent = 'Testing…';
    const r = await api.invoke('settings:testOpenAI');
    $('openaiKeyHint').textContent = r.ok ? `Works with ${current.liveModel}.` : `Failed: ${r.error}`;
  });

  /* ---------- Devices ---------- */
  async function loadDevices(askPermission) {
    try {
      if (askPermission) {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
      }
    } catch {}
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    const mic = $('micDeviceId');
    const src = $('interviewerSource');
    mic.textContent = '';
    src.textContent = '';
    mic.appendChild(new Option('System default microphone', 'default'));
    src.appendChild(new Option('System audio (everything you hear)', 'system'));
    devices
      .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
      .forEach((d, i) => {
        const label = d.label || `Input ${i + 1}`;
        mic.appendChild(new Option(label, d.deviceId));
        src.appendChild(new Option(`Input device: ${label}`, d.deviceId));
      });
    const pick = (sel, want, fallback) => {
      sel.value = want;
      if (sel.value !== want) sel.value = fallback;
    };
    pick(mic, mic.dataset.want || (current && current.micDeviceId) || 'default', 'default');
    pick(src, src.dataset.want || (current && current.interviewerSource) || 'system', 'system');
  }
  $('btnRefreshDevices').addEventListener('click', () => loadDevices(true));

  let testing = null;
  $('btnTestMic').addEventListener('click', async () => {
    if (testing) {
      testing.stop();
      testing = null;
      $('btnTestMic').textContent = 'Test mic';
      $('micMeter').style.width = '0';
      return;
    }
    try {
      const id = $('micDeviceId').value;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: id && id !== 'default' ? { deviceId: { exact: id } } : true });
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      let raf;
      const tick = () => {
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const rms = Math.sqrt(sum / buf.length);
        $('micMeter').style.width = Math.min(100, rms * 600) + '%';
        raf = requestAnimationFrame(tick);
      };
      tick();
      testing = {
        stop() {
          cancelAnimationFrame(raf);
          stream.getTracks().forEach((t) => t.stop());
          ctx.close();
        }
      };
      $('btnTestMic').textContent = 'Stop test';
    } catch (e) {
      $('btnTestMic').textContent = 'Test mic';
      alertIn('startError', 'Microphone: ' + e.message);
    }
  });

  /* ---------- Research ---------- */
  function alertIn(id, msg) {
    const a = $(id);
    if (!msg) return a.classList.add('hidden');
    a.textContent = msg;
    a.classList.remove('hidden');
  }

  function link(url) {
    if (!url || !/^https?:\/\//i.test(url)) return null;
    const a = el('a', '', 'Source ↗');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  function itemNode(it) {
    const n = el('div', 'pitem');
    n.appendChild(el('div', 't', it.title));
    const body = it.kind === 'post' ? it.summary : it.detail;
    if (body) n.appendChild(el('div', 'd', body));
    const meta = [it.source, it.date].filter(Boolean).join(' · ');
    if (meta) n.appendChild(el('div', 'm', meta));
    const a = link(it.url);
    if (a) n.appendChild(a);
    return n;
  }

  function col(title, sub, posts, achievements) {
    const c = el('div', 'pcol');
    c.appendChild(el('h3', '', title));
    if (sub) c.appendChild(el('div', 'muted', sub));
    c.appendChild(el('h4', '', 'Latest posts'));
    if (!posts.length) c.appendChild(el('div', 'muted small', 'Nothing found.'));
    posts.forEach((p) => c.appendChild(itemNode(p)));
    c.appendChild(el('h4', '', 'Big achievements'));
    if (!achievements.length) c.appendChild(el('div', 'muted small', 'Nothing found.'));
    achievements.forEach((a) => c.appendChild(itemNode(a)));
    return c;
  }

  function renderResearch(r) {
    const box = $('researchPreview');
    box.textContent = '';
    if (!r) {
      box.appendChild(el('div', 'empty', 'No research yet. Fill in the interviewer and company above, then run research. It usually takes 30–90 seconds.'));
      $('researchState').textContent = '';
      return;
    }
    $('researchState').textContent = 'Last run ' + new Date(r.at).toLocaleString();
    box.appendChild(col(r.interviewer.name || 'Interviewer', r.interviewer.headline, r.interviewer.posts, r.interviewer.achievements));
    box.appendChild(col(r.company.name || 'Company', r.company.summary, r.company.posts, r.company.achievements));
    if (r.conversationStarters && r.conversationStarters.length) {
      const c = el('div', 'pcol');
      c.style.gridColumn = '1 / -1';
      c.appendChild(el('h3', '', 'Questions you could ask'));
      r.conversationStarters.forEach((q) => c.appendChild(el('div', 'd', '• ' + q)));
      box.appendChild(c);
    }
  }

  $('btnResearch').addEventListener('click', async () => {
    alertIn('researchError', '');
    clearTimeout(profileTimer);
    await api.invoke('profile:set', collectProfile());
    $('btnResearch').disabled = true;
    const started = Date.now();
    const tick = setInterval(() => ($('researchState').textContent = `Searching the web… ${Math.round((Date.now() - started) / 1000)}s`), 1000);
    const r = await api.invoke('research:run');
    clearInterval(tick);
    $('btnResearch').disabled = false;
    if (r.ok) renderResearch(r.research);
    else {
      $('researchState').textContent = '';
      alertIn('researchError', r.error);
      if (/key/i.test(r.error)) goSettings();
    }
  });

  /* ---------- Session ---------- */
  $('btnStart').addEventListener('click', async () => {
    alertIn('startError', '');
    clearTimeout(profileTimer);
    await api.invoke('profile:set', collectProfile());
    if (testing) $('btnTestMic').click();
    const r = await api.invoke('session:start');
    if (!r.ok) {
      alertIn('startError', r.error);
      if (/key/i.test(r.error)) goSettings();
    }
  });

  api.on('session:status', (s) => {
    $('sessionState').textContent = s.running ? (s.paused ? 'Session paused' : 'Session running') : '';
    const demo = s.mode === 'demo' ? ' (demo)' : '';
    $('btnStart').textContent = (s.running ? 'Restart call assistant' : 'Start call assistant') + demo;
  });

  /* ---------- Init ---------- */
  (async () => {
    const [s, p, r] = await Promise.all([api.invoke('settings:get'), api.invoke('profile:get'), api.invoke('research:get')]);
    fillSettings(s);
    profileFields.forEach((f) => (f.value = p[f.id] || ''));
    renderResearch(r);
    await loadDevices(true);
    if (!s.openaiKeySet) goSettings();
  })();
})();
