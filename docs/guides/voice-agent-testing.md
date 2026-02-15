# Voice Agent Testing Guide

Test audio-based AI agents (voice assistants, phone agents, audio chatbots) by injecting microphone input and capturing spoken responses — all via CDP, no special browser flags required.

## How It Works

```
Page.setupAudio()
  ├── AudioInput: monkey-patches getUserMedia → fake MediaStream via AudioContext
  │   └── play(bytes) → decodeAudioData → AudioBufferSourceNode → destination
  └── AudioOutput: intercepts AudioNode.connect + HTMLMediaElement.play
      └── Per-context ScriptProcessorNode taps PCM → Runtime.addBinding → Node.js

Page.audioRoundTrip()
  1. Start output capture (taps all AudioContexts)
  2. Play input audio into fake mic
  3. captureUntilSilence (RMS-based silence detection)
  4. Return { audio, latencyMs, totalMs }

Transcription: transcribe(CaptureResult) → pcmToWav → Whisper API
```

The key insight: browser-pilot intercepts the browser's audio APIs at the JavaScript level. When a voice agent calls `getUserMedia()`, it gets our fake MediaStream. When it plays audio through an `AudioContext`, we tap the output via `ScriptProcessorNode`. This works on any already-running browser — no launch flags needed.

## Prerequisites

1. Chrome running with `--remote-debugging-port=9222`
2. A WAV file to use as input (or generate one — see [Generating Test Audio](#generating-test-audio))
3. `OPENAI_API_KEY` in environment or `.env` (for transcription)

## Quick Start (Copy-Paste)

```bash
# Connect to local Chrome
bp connect --provider generic --name voice-test

# Navigate to voice agent page
bp exec -s voice-test '{"action":"goto","url":"https://my-voice-app.com"}'

# Set up audio overrides (BEFORE agent initializes)
bp audio setup -s voice-test

# Wait for agent to initialize, then validate
bp audio check -s voice-test
# Expected: "READY for roundtrip"

# Send prompt, capture response, transcribe
bp audio roundtrip -s voice-test -i prompt.wav -o response.wav \
  --transcribe --silence-timeout 1500
```

## Step-by-Step Workflow

### 1. Connect to Browser

```bash
bp connect --provider generic --name voice-test
```

If you get the wrong tab (devtools, extensions), specify the WebSocket URL:

```bash
# List tabs to find the right one
curl -s http://localhost:9222/json/list | python3 -c "
import json,sys
for t in json.load(sys.stdin):
    if t['type']=='page': print(t['webSocketDebuggerUrl'], t['url'])"

# Connect to specific tab
bp connect --provider generic --name voice-test --ws-url ws://localhost:9222/devtools/page/XXXXX
```

### 2. Navigate to the Voice Agent Page

```bash
bp exec -s voice-test '{"action":"goto","url":"https://my-voice-app.com"}'
```

### 3. Set Up Audio Overrides

**This is the critical step.** Audio overrides MUST be injected BEFORE the voice agent creates its `AudioContext` and calls `getUserMedia()`.

```bash
bp audio setup -s voice-test
```

If the agent auto-initializes on page load (common), the correct sequence is:

```bash
# 1. Navigate to page
bp exec -s voice-test '{"action":"goto","url":"https://my-voice-app.com"}'
# 2. Setup audio (injected into page JS globals)
bp audio setup -s voice-test
# 3. Reload so agent initializes AFTER overrides are in place
bp exec -s voice-test '{"action":"goto","url":"https://my-voice-app.com"}'
```

Wait: `audio setup` persists across navigations? **No.** The overrides modify JS prototypes (`getUserMedia`, `AudioNode.connect`). A page reload clears them. The correct pattern for auto-initializing agents:

```bash
# Setup injects overrides into page globals
bp audio setup -s voice-test
# Navigate (or reload) — agent initializes and hits our overridden APIs
bp exec -s voice-test '{"action":"goto","url":"https://my-voice-app.com"}'
# Wait a few seconds for agent to create AudioContexts
sleep 3
# Validate
bp audio check -s voice-test
```

Actually, `bp audio check` and `bp audio roundtrip` both auto-run setup if needed. So the simplest approach:

```bash
bp exec -s voice-test '{"action":"goto","url":"https://my-voice-app.com"}'
sleep 3
bp audio check -s voice-test    # auto-sets up + validates
```

### 4. Validate the Pipeline

```bash
bp audio check -s voice-test
```

**Good output** (agent detected):
```
Audio Pipeline Check
  Overrides:
    getUserMedia:       overridden
    AudioNode.connect:  overridden
    AudioContext:       overridden (tracking 3 contexts)

  AudioContexts:
    48000 Hz  running  (browser-pilot input)
    8000 Hz   running  (likely voice agent)
    48000 Hz  running  (browser-pilot capture)

  Input (fake mic):   ready (48000Hz)
  Output (capture):   ready (3 taps, not capturing)

  Status: READY for roundtrip
```

**What to look for:**
- `READY for roundtrip` — you're good to go
- A non-48kHz AudioContext labeled `(likely voice agent)` — confirms the agent is active
- If 0 AudioContexts: the agent hasn't initialized yet (wait or interact with the page)

Use `--json` for scripting:
```bash
bp audio check -s voice-test --json
# { "ready": true, "agentDetected": true, "agentSampleRate": 8000, ... }
```

### 5. Run Voice Roundtrip

```bash
bp audio roundtrip -s voice-test -i prompt.wav --transcribe --silence-timeout 1500
```

Output:
```
Voice Roundtrip Complete
  Input:    prompt.wav (90.3KB)
  Latency:  5.2s (time to first response)
  Response: 12.3s of audio (30 chunks)
  Total:    18.5s
  Transcript: "Welcome! I'd be happy to help you find something..."
```

Save the response audio:
```bash
bp audio roundtrip -s voice-test -i prompt.wav -o response.wav --transcribe
```

Debug with verbose output:
```bash
bp audio roundtrip -s voice-test -i prompt.wav --verbose --silence-timeout 1500
# Shows per-chunk RMS levels, silence detection phases, sample rate grouping
```

### 6. Multi-Turn Conversations

Run multiple roundtrips in sequence:

```bash
bp audio roundtrip -s voice-test -i greeting.wav --transcribe --silence-timeout 1500
bp audio roundtrip -s voice-test -i question.wav --transcribe --silence-timeout 1500
bp audio roundtrip -s voice-test -i followup.wav --transcribe --silence-timeout 1500
```

### 7. Validate the Response

```bash
# Check saved WAV file
file response.wav
# Expected: RIFF (little-endian) data, WAVE audio, Microsoft PCM, 16 bit, mono XXXX Hz

# Check duration
ffprobe -v quiet -print_format json -show_streams response.wav | python3 -c "
import json,sys; s=json.load(sys.stdin)['streams'][0]
print(f'Duration: {float(s[\"duration\"]):.1f}s, Rate: {s[\"sample_rate\"]}Hz')"

# Independently transcribe with Whisper
source .env
curl -s https://api.openai.com/v1/audio/transcriptions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F "file=@response.wav" -F "model=whisper-1" -F "language=en"
```

## Key Options Reference

| Option | Default | Description |
|--------|---------|-------------|
| `--silence-timeout <ms>` | 1500 | Stop capture after N ms of silence. Agents rarely pause >1.5s mid-sentence. |
| `--transcribe` | off | Transcribe via Whisper API. Adds ~1-2s. Requires `OPENAI_API_KEY`. |
| `--language <lang>` | auto | Language hint for transcription (`en`, `es`, `ja`). Improves accuracy. |
| `--pre-delay <ms>` | 0 | Wait before playing input. Use if page needs setup time. |
| `--send-selector <sel>` | none | Click this selector after input finishes (push-to-talk UIs). |
| `--verbose` | off | Show live RMS levels, silence detection, sample rate grouping. |
| `-o, --out <file>` | none | Save captured response audio to WAV file. |
| `--json` | off | Structured output for CI/scripting. |

## Common Patterns

### Push-to-Talk Agents

Some voice UIs require clicking a button to send audio:

```bash
bp audio roundtrip -i prompt.wav --send-selector "#send-btn" --transcribe
```

### Slow-Loading Agents

If the agent needs time to initialize after page load:

```bash
bp audio roundtrip -i prompt.wav --pre-delay 3000 --transcribe
```

### Capture-Only (Agent Already Speaking)

```bash
bp audio capture --transcribe --silence-timeout 1500
```

### CI/Scripting with JSON Output

```bash
result=$(bp audio roundtrip -i prompt.wav --transcribe --json)
echo "$result" | jq '.transcript'
echo "$result" | jq '.latencyMs'
```

### Programmatic API (TypeScript)

```typescript
import { connect, transcribe } from 'browser-pilot';
import { readFileSync } from 'fs';

const browser = await connect({ provider: 'generic' });
const page = await browser.page();

await page.goto('https://my-voice-app.com');
await page.setupAudio();

const audioBytes = readFileSync('prompt.wav');
const result = await page.audioRoundTrip({
  input: new Uint8Array(audioBytes),
  silenceTimeout: 1500,
});

const { text } = await transcribe(result.audio);
console.log(text); // "Welcome! I'd be happy to help..."

await browser.close();
```

## Troubleshooting

### Pipeline Status Issues

| `bp audio check` shows | Cause | Fix |
|------------------------|-------|-----|
| 0 AudioContexts | Agent hasn't initialized | Wait, interact with page, or reload |
| `NOT READY (input not ready)` | Overrides injected after agent init | Reload page (overrides auto-re-inject) |
| No `(likely voice agent)` context | Agent uses 48kHz (same as browser-pilot) | Still works — just harder to distinguish |

### Roundtrip Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `latencyMs: -1` | Agent never responded | Run `bp audio check`, verify agent is active |
| Transcript is garbage ("You You") | Multi-rate audio merge issue | Update to latest code (groups by sample rate) |
| Capture runs 60s+ with no audio | Dead capture, no early exit | Update to latest code (15s `noAudioTimeout`) |
| Response WAV is silence | Wrong sample rate group selected | Use `--verbose` to check which rate has audio |
| `OPENAI_API_KEY` error | Missing or invalid key | `export OPENAI_API_KEY=sk-...` or add to `.env` |

### Setup Order Issues

The most common failure mode: overrides injected **after** the voice agent already created its AudioContext.

**Signs:** `bp audio check` shows `READY` but capture returns silence. The agent's AudioContext was created before our `AudioNode.connect` override, so we never tapped it.

**Fix:** Reload the page. `bp audio check` auto-runs setup, and the reload ensures the agent re-creates its AudioContext after our overrides are in place.

```bash
bp exec -s voice-test '{"action":"goto","url":"https://my-voice-app.com"}'
sleep 3
bp audio check -s voice-test
```

### Audio Architecture Details

Voice agents typically create AudioContexts at non-standard sample rates:
- **8kHz** — telephony-grade (some agents)
- **16kHz** — common for speech processing
- **24kHz** — higher quality speech
- **48kHz** — browser default (browser-pilot uses this for input/capture)

browser-pilot automatically groups captured chunks by sample rate and selects the group with the most non-silent audio. This handles the common case where our 48kHz input/capture contexts produce silent chunks alongside the agent's actual speech at a different rate.

### What Persists Across CLI Commands

| What | Persists? | Notes |
|------|-----------|-------|
| JS prototype overrides (getUserMedia, connect) | Yes | Same page context |
| `window.__bp*` properties | Yes | Same page context |
| `Runtime.addBinding` (CDP) | No | Tied to CDP session — re-established automatically |
| Audio overrides after navigation | No | Page reload clears JS globals |

## Generating Test Audio

Use the bundled TTS script to create WAV prompts from text:

```bash
# Requires OPENAI_API_KEY
uv run docs/skill/generate-audio.py "Hello, what can you help me with?" -o prompt.wav
uv run docs/skill/generate-audio.py "Can you tell me more about that?" -o followup.wav

# Options
uv run docs/skill/generate-audio.py "text" --voice nova --model tts-1-hd -o high-quality.wav
```

## Success Criteria

| Check | Pass |
|-------|------|
| `bp audio check` | Shows `READY` with agent AudioContext detected |
| `bp audio roundtrip` | `latencyMs` > 0 (not -1) |
| Response duration | Matches agent speech (~5-15s typical) |
| WAV file | `file response.wav` shows valid RIFF header |
| WAV non-silent | `ffprobe` duration matches reported duration |
| Whisper transcript | Coherent English, not "You" or garbage |
| Sample rate | WAV rate matches agent context (8kHz, 16kHz, etc.) |
