# Interview Copilot

A see-through overlay that sits on top of Zoom, Meet or Teams during a video interview.

- **Social tab:** the interviewer's latest posts and big achievements, plus the company's, all found by web search before the call. When an item fits what's being discussed, the tab pings and the item is marked **Relevant now**.
- **Technical tab:** when the interviewer asks a technical question, a short answer card with talking points appears and the tab pings. You can also type a question privately.
- **Turn detection:** your microphone is "You" and the call's audio is "Interviewer". Because they are separate streams, every line of the transcript is labeled with the right speaker.

## Quick start (Windows or macOS)

```bash
npm install
npm run demo      # scripted conversation, no keys or audio needed: check the overlay
npm start         # the real app
```

1. **Settings:** paste your **OpenAI API key**. It's required for answers and research. Click **Test**.
   For transcription, either paste an **AssemblyAI key** (the default provider) or switch the provider to **OpenAI**.
2. **Interview:** fill in the interviewer, company and role. The job description and your background are optional but make the answers better. Click **Run research**. It takes about 30–90 seconds and the results are saved.
3. Click **Start call assistant**, then join your call. **Wear headphones.** Otherwise your mic also picks up the interviewer.

### Hotkeys
| Keys | Action |
| --- | --- |
| Ctrl/Cmd + Shift + H | Show / hide the overlay |
| Ctrl/Cmd + Shift + 1 | Open / close Social |
| Ctrl/Cmd + Shift + 2 | Open / close Technical |
| Ctrl/Cmd + Shift + 0 | Close panels |
| Esc (when the overlay has focus) | Close panels |

The status pill at the top has pause, transcript on/off, setup and end-session buttons.
Clicks pass through the overlay to your call app everywhere except on the tabs, the panels and the pill.
**Hide overlay from screen sharing** is on by default, so if you share your screen, the overlay isn't captured.

## Audio setup

| | You (mic) | Interviewer (call audio) |
| --- | --- | --- |
| Windows | any input device | **System audio** works out of the box (loopback) |
| macOS 13+ | any input device | **System audio** needs the packaged app (`npm run dist:mac`) and permission in System Settings → Privacy & Security. Or install [BlackHole](https://existential.audio/blackhole/), send call audio to a Multi-Output Device (speakers + BlackHole) and choose BlackHole under *Call audio*. |

## How it works

```
mic ──► AudioWorklet (PCM16, 100 ms) ──► main ──► STT WebSocket  ─┐
call audio (loopback) ──► AudioWorklet ──► main ──► STT WebSocket ─┤ speaker-labelled turns
                                                                    ▼
                         OpenAI Responses (live model, JSON schema) ──► Technical card / Social relevance ──► pings
pre-call: OpenAI Responses + web_search ──► research.json (posts, achievements, sources)
```

- `src/main/transcribe/assemblyai.js`: Universal Streaming v3, with end-of-turn detection on the provider's side.
- `src/main/transcribe/openai.js`: realtime transcription session. The app itself detects pauses in speech (VAD) and commits each finished utterance.
- `src/main/ai.js`: research (web search) and the per-turn analysis prompt and schema.
- `src/main/main.js`: windows, click-through, hotkeys, session orchestration (analysis runs after every interviewer turn, and at most every 25 s after your turns).
- `src/renderer/overlay.*`: the overlay UI. `src/renderer/setup.*`: the setup window.
- Settings, profile and research are stored in the app's user-data folder. API keys are encrypted with your operating system's keychain (Electron `safeStorage`).

## Models

The model names can be changed in Settings. Defaults:
- Live answers: `gpt-5.4-mini`
- Research: `gpt-5.4-mini`, with the `web_search` tool
- OpenAI transcription: `gpt-live-transcribe`

If a model isn't available on your account, change it to one that is. Set **Reasoning effort** to *Off* for models that don't do reasoning.

## Checks

- `npm run check`: offline tests (syntax, JSON parsing, both transcription providers against a fake socket).
- `npm run live-test`: real API test using keys from `.env` (`OPENAI_API_KEY`, `ASSEMBLYAI_API_KEY`). It checks the model, live analysis, and streams generated speech through AssemblyAI and OpenAI transcription. Add `-- --research "Name" "Company"` to also test web research. `.env` is git-ignored and never packaged.

## Please note

- Many places require consent from everyone on a call before it's recorded or transcribed. Check the laws where you and the interviewer are, and the company's interview policy.
- Each session sends audio to your transcription provider and transcript text to OpenAI, so it costs money on both.
