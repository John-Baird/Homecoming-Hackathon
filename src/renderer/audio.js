// Captures two independent audio streams so speaker turns are known from the channel:
//   "mic"  = your microphone
//   "call" = the call's audio (system loopback, or a chosen virtual input device)
// Who is actually speaking (and in which role) is worked out in the main process.
// Each is resampled by its AudioContext to the provider's rate and framed by the worklet.
(function () {
  const active = [];

  async function openMic(deviceId) {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      },
      video: false
    });
  }

  async function openSystemAudio() {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => t.stop());
    if (stream.getAudioTracks().length === 0) {
      throw new Error('No system audio track. On macOS, allow audio/screen recording for this app, or pick a virtual input device (e.g. BlackHole) for call audio in Settings.');
    }
    return new MediaStream(stream.getAudioTracks());
  }

  async function wire(channel, stream, sampleRate, onLevel) {
    const ctx = new AudioContext({ sampleRate });
    await ctx.audioWorklet.addModule('pcm-worklet.js');
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pcm-framer');
    node.port.onmessage = ({ data }) => {
      window.copilot.send('audio:chunk', { channel, data: data.pcm, rms: data.rms });
      onLevel(channel, data.rms);
    };
    src.connect(node);
    // Worklets only run when connected to the graph; route to a muted gain so nothing plays.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(ctx.destination);
    stream.getAudioTracks().forEach((t) =>
      t.addEventListener('ended', () => window.copilot.send('audio:error', { channel, message: 'audio source ended' }))
    );
    active.push({ ctx, stream });
  }

  async function start({ sampleRate, micDeviceId, interviewerSource, onLevel }) {
    stop();
    const tasks = [
      (async () => {
        try {
          await wire('mic', await openMic(micDeviceId), sampleRate, onLevel);
        } catch (e) {
          window.copilot.send('audio:error', { channel: 'mic', message: e.message || String(e) });
        }
      })(),
      (async () => {
        try {
          const stream = interviewerSource && interviewerSource !== 'system' ? await openMic(interviewerSource) : await openSystemAudio();
          await wire('call', stream, sampleRate, onLevel);
        } catch (e) {
          window.copilot.send('audio:error', { channel: 'call', message: e.message || String(e) });
        }
      })()
    ];
    await Promise.all(tasks);
  }

  function stop() {
    while (active.length) {
      const { ctx, stream } = active.pop();
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
    }
  }

  window.CopilotAudio = { start, stop };
})();
