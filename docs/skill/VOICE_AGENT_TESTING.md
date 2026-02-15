# Voice Agent Testing with browser-pilot

Step-by-step guide for AI agents testing voice/audio web applications. Covers setup, execution, troubleshooting, and validation.

> For the full architecture and details, see [Voice Agent Testing Guide](../guides/voice-agent-testing.md).

## The Process

```
1. Connect to browser          bp connect --provider generic --name voice-test
2. Navigate to voice agent      bp exec -s voice-test '{"action":"goto","url":"..."}'
3. Set up audio overrides       bp audio setup -s voice-test  (or let check/roundtrip auto-setup)
4. Reload page                  bp exec -s voice-test '{"action":"goto","url":"..."}'
   ↑ CRITICAL: overrides must exist BEFORE agent creates AudioContext
5. Wait for agent init          sleep 3
6. Validate pipeline            bp audio check -s voice-test  → expect "READY"
7. Run roundtrip                bp audio roundtrip -s voice-test -i prompt.wav --transcribe
8. Validate response            Check latencyMs > 0, transcript is coherent
```

## Setup Order (Most Common Mistake)

Audio overrides monkey-patch `getUserMedia` and `AudioNode.connect`. They MUST be in place BEFORE the voice agent initializes. If the agent auto-starts on page load:

```bash
# Setup first, then navigate (overrides auto-re-inject on check/roundtrip)
bp audio setup -s voice-test
bp exec -s voice-test '{"action":"goto","url":"https://my-voice-app.com"}'
sleep 3
bp audio check -s voice-test
```

If you get `NOT READY` or 0 AudioContexts — the agent initialized before overrides. Reload the page.

## Quick Start

### Already Have a WAV File

```bash
bp connect --provider generic --name vt
bp exec -s vt '{"action":"goto","url":"https://my-voice-app.com"}'
sleep 3
bp audio check -s vt
bp audio roundtrip -s vt -i prompt.wav --transcribe --silence-timeout 1500
```

### Need to Generate a WAV File

```bash
# Requires OPENAI_API_KEY
uv run docs/skill/generate-audio.py "Hello, what can you help me with?" -o prompt.wav
```

### Agent Requires Click-to-Start

```bash
bp connect --provider generic --name vt
bp audio setup -s vt
bp exec -s vt '{"action":"goto","url":"https://my-voice-app.com"}'
sleep 2
# Take snapshot to find the start button
bp snapshot -s vt -i
# Click it (use ref from snapshot, or CSS selector)
bp exec -s vt '{"action":"click","selector":"ref:e4"}'
sleep 3  # Agent needs time to create AudioContexts after click
bp audio check -s vt  # Expect non-48kHz contexts = voice agent detected
bp audio roundtrip -s vt -i prompt.wav --transcribe --silence-timeout 1500
```

### Agent Auto-Starts on Page Load

```bash
bp connect --provider generic --name vt
bp exec -s vt '{"action":"goto","url":"https://my-voice-app.com"}'
# Overrides auto-inject on check, then reload to let agent re-init
bp audio check -s vt
# If NOT READY, reload:
bp exec -s vt '{"action":"goto","url":"https://my-voice-app.com"}'
sleep 3
bp audio check -s vt
# Now READY
bp audio roundtrip -s vt -i prompt.wav --transcribe --silence-timeout 1500
```

## Reading `bp audio check` Output

```
Audio Pipeline Check
  Overrides:
    getUserMedia:       overridden       ← Must be "overridden"
    AudioNode.connect:  overridden       ← Must be "overridden"
    AudioContext:       overridden (tracking 3 contexts)

  AudioContexts:
    48000 Hz  running  (browser-pilot input)    ← Our fake mic
    8000 Hz   running  (likely voice agent)      ← The agent (non-48kHz = agent)
    48000 Hz  running  (browser-pilot capture)   ← Our capture tap

  Input (fake mic):   ready (48000Hz)
  Output (capture):   ready (3 taps, not capturing)

  Status: READY for roundtrip          ← Green light
```

**Key signals:**
- A non-48kHz AudioContext = voice agent detected (8kHz, 16kHz, 24kHz are common)
- If `(tracking 0 contexts)` — agent hasn't started, wait or interact with page
- `READY for roundtrip` = all overrides in place, input and output functional

## Key Options

| Option | Default | When to Use |
|--------|---------|-------------|
| `--silence-timeout` | 1500ms | Increase for agents with long thinking pauses |
| `--transcribe` | off | Almost always — gives you the text response |
| `--verbose` | off | When debugging — shows per-chunk RMS levels |
| `-o response.wav` | none | When you need to save/validate the audio |
| `--pre-delay` | 0 | When agent needs time after audio injection |
| `--send-selector` | none | For push-to-talk UIs (click after speaking) |
| `--json` | off | For scripting / CI pipelines |
| `--language` | auto | Hint for non-English agents (`es`, `ja`, etc.) |

## Troubleshooting Decision Tree

```
Problem: No response (latencyMs = -1)
├── Run bp audio check
│   ├── 0 AudioContexts → Agent not initialized → Reload page, wait, try again
│   ├── NOT READY → Overrides missing → bp audio setup, then reload
│   └── READY but no response → Agent didn't process our audio
│       ├── Try --verbose to see if chunks arrive
│       ├── Check if agent requires a button click (--send-selector)
│       └── Check if agent requires specific audio format/sample rate

Problem: Transcript is garbage ("You You", random words)
├── Audio data corrupt → Use --verbose, check sample rate grouping
├── Multi-rate merge bug → Update to latest code
└── WAV file too short → Check input file duration (> 1s recommended)

Problem: Capture runs forever
├── No audio arriving → Check --verbose for "no audio detected" message
├── noAudioTimeout should trigger at 15s → Update to latest code
└── Agent responding with very quiet audio → Lower --silence-threshold

Problem: bp audio check shows NOT READY
├── input not ready → Overrides not injected → Run bp audio setup
├── output not set up → Same as above
└── getUserMedia not overridden → Page was reloaded after setup → Re-setup
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

## Validating Results

### Quick Validation

```bash
# 1. Check pipeline
bp audio check -s vt
# → READY, agent detected

# 2. Check roundtrip
bp audio roundtrip -s vt -i prompt.wav --transcribe --silence-timeout 1500
# → latencyMs > 0, transcript is coherent English
```

### Full Validation (with saved audio)

```bash
# Save response
bp audio roundtrip -s vt -i prompt.wav -o response.wav --transcribe --silence-timeout 1500

# Validate WAV file
file response.wav
# → RIFF (little-endian) data, WAVE audio, Microsoft PCM, 16 bit, mono XXXX Hz

# Check duration matches reported
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
# Required for transcription
export OPENAI_API_KEY=sk-...

# Chrome with remote debugging (required)
chrome --remote-debugging-port=9222
```
