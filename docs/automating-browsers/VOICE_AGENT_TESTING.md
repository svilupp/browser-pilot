# Voice Agent Testing with browser-pilot

Step-by-step guide for AI agents testing voice/audio web applications. Covers setup, execution, troubleshooting, and validation.

> For the full architecture and details, see [Voice Agent Testing Guide](../guides/voice-agent-testing.md).

## Which Pattern Do You Need?

Voice agents initialize differently. Pick the right pattern:

| Agent Type | How to Tell | Pattern |
|-----------|-------------|---------|
| **Click-to-start** | Has a mic/call button; no audio until you click it | [Click-to-Start](#click-to-start) |
| **Auto-start** | Starts speaking or listening on page load | [Auto-Start](#auto-start) |
| **Push-to-talk** | Has a "send" button after speaking | Use `--send-selector` with either pattern |

**The golden rule:** Audio overrides MUST be injected BEFORE the agent creates its `AudioContext`. If you miss this window, the agent's audio bypasses our monkey-patches and capture returns silence.

## Click-to-Start

Most common pattern. The agent only creates `AudioContext` after a user interaction (button click, etc.).

```bash
# 1. Connect
bp connect --provider generic --name vt

# 2. Setup overrides + navigate (order matters)
bp audio setup -s vt
bp exec -s vt '{"action":"goto","url":"https://my-voice-app.com"}'
sleep 2

# 3. Find and click the start button
bp snapshot -s vt -i
bp exec -s vt '{"action":"click","selector":"ref:e4"}'  # or CSS selector
sleep 3  # agent needs time to create AudioContexts

# 4. Validate pipeline
bp audio check -s vt
# → Expect: READY, non-48kHz AudioContext = voice agent detected

# 5. Run roundtrip
bp audio roundtrip -s vt -i prompt.wav --transcribe --silence-timeout 1500
```

**Why setup before goto?** Navigation clears JS state. By setting up first, then navigating, the overrides are re-injected on the fresh page before any JS runs.

## Auto-Start

The agent starts listening/speaking immediately on page load (no click required).

```bash
# 1. Connect
bp connect --provider generic --name vt

# 2. Setup overrides FIRST, then navigate
bp audio setup -s vt
bp exec -s vt '{"action":"goto","url":"https://my-voice-app.com"}'
sleep 3

# 3. Validate pipeline
bp audio check -s vt
# → Expect: READY, non-48kHz AudioContext = voice agent detected

# 4. Run roundtrip
bp audio roundtrip -s vt -i prompt.wav --transcribe --silence-timeout 1500
```

**If `bp audio check` shows 0 AudioContexts or NOT READY:** The agent initialized before overrides. Re-run the same steps (setup → goto → wait → check).

## Generating a WAV Prompt

If you don't have a WAV file to send:

```bash
# Requires OPENAI_API_KEY
uv run docs/automating-browsers/generate-audio.py "Hello, what can you help me with?" -o prompt.wav
```

## What Success Looks Like

### `bp audio check` — Pipeline Ready

```
Audio Pipeline Check
  Overrides:
    getUserMedia:       overridden       ← Must be "overridden"
    AudioNode.connect:  overridden       ← Must be "overridden"
    AudioContext:       overridden (tracking 4 contexts)

  AudioContexts:
    48000 Hz  running  (browser-pilot input)    ← Our fake mic
    16000 Hz  running  (likely voice agent)      ← The agent (non-48kHz = agent)
    8000 Hz   running  (likely voice agent)      ← Some agents use multiple
    48000 Hz  running  (browser-pilot capture)   ← Our capture tap

  Input (fake mic):   ready (48000Hz)
  Output (capture):   ready (4 taps, not capturing)

  Status: READY for roundtrip          ← Green light
```

**Key signals:**
- Non-48kHz AudioContext = voice agent detected (8kHz, 16kHz, 24kHz are common)
- `(tracking 0 contexts)` = agent hasn't started — wait, interact, or reload
- `READY for roundtrip` = all overrides in place, input and output functional

### `bp audio roundtrip` — Successful Response

```
Round-trip: playing prompt.wav (90.3KB), waiting for response...
Voice Roundtrip Complete
  Input:    prompt.wav (90.3KB)
  Latency:  5.4s (time to first response)
  Response: 8.4s of audio (21 chunks)
  Total:    8.9s
  Saved:    response.wav
  Transcript: "I'm here to help you explore David's collection."
```

**What to check:**
- `Latency` > 0 (not -1, which means no response)
- `Response` has audio chunks (not 0)
- `Transcript` is coherent (not garbage like "You You" or empty)

## Key Options

| Option | Default | When to Use |
|--------|---------|-------------|
| `--silence-timeout` | 1500ms | Increase for agents with long thinking pauses |
| `--transcribe` | off | Almost always — gives you the text response |
| `--verbose` | off | When debugging — shows per-chunk RMS levels |
| `-o response.wav` | none | Save response audio to file for validation |
| `--pre-delay` | 0 | When agent needs time after audio injection |
| `--send-selector` | none | For push-to-talk UIs (click after speaking) |
| `--json` | off | For scripting / CI pipelines |
| `--language` | auto | Hint for non-English agents (`es`, `ja`, etc.) |

## Troubleshooting

Always start with `bp audio check`. The output tells you exactly what's wrong.

```
Problem: No response (latencyMs = -1)
├── bp audio check shows 0 AudioContexts
│   → Agent not initialized → Reload page, wait, interact, try again
├── bp audio check shows NOT READY
│   → Overrides missing → bp audio setup, then reload page
└── bp audio check shows READY but no response
    → Agent didn't process our audio
    ├── Use --verbose to see if chunks arrive at all
    ├── Agent may require a button click → use --send-selector
    └── Agent may require specific audio format/sample rate

Problem: Transcript is garbage ("You You", random words)
├── Audio data corrupt → Use --verbose, check sample rate grouping
├── Multi-rate merge bug → Update to latest code
└── WAV file too short → Input should be > 1s duration

Problem: Capture runs forever
├── No audio arriving → --verbose shows "no audio detected" message
├── noAudioTimeout (15s) should auto-trigger → Update to latest code
└── Agent responding very quietly → Lower --silence-threshold

Problem: response.wav missing or 0 bytes
├── Roundtrip got no audio → Check latencyMs (if -1, agent didn't respond)
└── Capture returned empty → Re-run bp audio check, verify READY status
```

## Multi-Turn Testing

```bash
# Turn 1: Greeting
bp audio roundtrip -s vt -i greeting.wav --transcribe --silence-timeout 1500

# Turn 2: Question
bp audio roundtrip -s vt -i question.wav --transcribe --silence-timeout 1500

# Turn 3: Follow-up
bp audio roundtrip -s vt -i followup.wav --transcribe --silence-timeout 1500
```

Each roundtrip reuses the same session — the agent maintains conversation context.

## Validating Saved Audio

```bash
# Save response during roundtrip
bp audio roundtrip -s vt -i prompt.wav -o response.wav --transcribe --silence-timeout 1500

# Verify WAV file format
file response.wav
# → RIFF (little-endian) data, WAVE audio, Microsoft PCM, 16 bit, ... XXXX Hz

# Check duration
ffprobe -v quiet -print_format json -show_streams response.wav | python3 -c "
import json,sys; s=json.load(sys.stdin)['streams'][0]
print(f'Duration: {float(s[\"duration\"]):.1f}s, Rate: {s[\"sample_rate\"]}Hz')"

# Independent Whisper check
curl -s https://api.openai.com/v1/audio/transcriptions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F "file=@response.wav" -F "model=whisper-1" -F "language=en"
```

## Environment

```bash
# Required for --transcribe
export OPENAI_API_KEY=sk-...

# Chrome with remote debugging (required)
chrome --remote-debugging-port=9222
```
