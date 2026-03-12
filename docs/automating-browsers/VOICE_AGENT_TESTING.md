# Voice Agent Testing with browser-pilot

Agent-facing quick guide for voice and audio apps.

Use the surfaces by job:

- `audio` for active control
- `trace summary --view voice` for explanation
- `record --profile voice` for reusable evidence
- `env` for permissions, network, and visibility tests

## Minimal working flow

```bash
bp connect --provider generic --name vt
bp audio setup -s vt
bp exec -s vt '{"action":"goto","url":"https://my-voice-app.com"}'
bp audio check -s vt
bp audio roundtrip -s vt -i prompt.wav --transcribe -o response.wav
bp trace summary -s vt --view voice
```

## Click-to-start apps

```bash
bp audio setup -s vt
bp exec -s vt '{"action":"goto","url":"https://my-voice-app.com"}'
bp snapshot -i -s vt
bp exec -s vt '{"action":"click","selector":"ref:e4"}'
bp audio check -s vt
```

## Capture a full artifact

```bash
bp record -s vt --profile voice -f ./artifacts/voice.recording.json
# exercise the app manually, then stop with Ctrl+C
bp record summary ./artifacts/voice.recording.json
bp trace summary ./artifacts/voice.recording.json --view voice
```

## Failure-mode tests

```bash
bp env permissions grant -s vt microphone
bp env visibility hidden -s vt
bp env network offline -s vt --duration 5000
```

Then inspect with:

```bash
bp trace summary -s vt --view voice
bp trace summary -s vt --view permissions
bp trace summary -s vt --view session
```

## Fast diagnosis rules

- `audio check` says `0 AudioContexts`: app has not initialized
- `audio check` says `NOT READY`: setup happened too late or app needs reload
- roundtrip returns no response: inspect `trace summary --view voice` and `--view console`
