# Voice Agent Testing Guide

Browser Pilot separates voice work into four jobs:

- `audio` for active control
- `record --profile voice` for capture
- `trace summary --view voice` for explanation
- `env` for permissions, visibility, and network failure modes

## Baseline workflow

```bash
bp connect --provider generic --name voice-test
bp audio setup -s voice-test
bp exec -s voice-test '{"action":"goto","url":"https://my-voice-app.com"}'
bp audio check -s voice-test
bp audio roundtrip -s voice-test -i prompt.wav --transcribe -o response.wav
bp trace summary -s voice-test --view voice
```

Use `bp audio check` as the first diagnostic command.

## Click-to-start apps

```bash
bp connect --provider generic --name vt
bp audio setup -s vt
bp exec -s vt '{"action":"goto","url":"https://my-voice-app.com"}'
bp snapshot -i -s vt
bp exec -s vt '{"action":"click","selector":"ref:e4"}'
bp audio check -s vt
bp audio roundtrip -s vt -i prompt.wav --transcribe -o response.wav
```

## Auto-start apps

```bash
bp connect --provider generic --name vt
bp audio setup -s vt
bp exec -s vt '{"action":"goto","url":"https://my-voice-app.com"}'
bp audio check -s vt
bp audio roundtrip -s vt -i prompt.wav --transcribe
```

Rule:

- Inject audio before the app initializes its media pipeline.

## Capture the session as an artifact

```bash
bp record -s vt --profile voice -f ./artifacts/voice.recording.json
# exercise the app manually, then stop with Ctrl+C
bp record summary ./artifacts/voice.recording.json
bp trace summary ./artifacts/voice.recording.json --view voice
```

This is the right path when you want a reusable evidence artifact, not just one roundtrip.

## Failure testing with env

Permissions:

```bash
bp env permissions get -s vt microphone
bp env permissions grant -s vt microphone
bp exec -s vt '[{"action":"assertPermission","name":"microphone","state":"granted"}]'
```

Visibility:

```bash
bp env visibility hidden -s vt
bp trace summary -s vt --view voice
bp env visibility visible -s vt
```

Network:

```bash
bp env network offline -s vt --duration 5000
bp trace summary -s vt --view session
bp trace summary -s vt --view voice
```

## What each surface answers

- `audio check`: is the pipeline ready right now?
- `audio roundtrip`: can I send prompt audio and capture a response?
- `trace summary --view voice`: what happened over time across capture, playback, permission, and voice readiness events?
- `record summary`: what did the whole session capture?

## Troubleshooting

If `audio check` shows:

- `0 AudioContexts`: the app has not initialized yet
- `NOT READY`: setup happened too late or the app needs to be reloaded
- no response on roundtrip: inspect `trace summary --view voice` and `--view console`

If transcription is poor:

- save the WAV with `-o response.wav`
- rerun with `--verbose`
- validate the response audio independently if needed
