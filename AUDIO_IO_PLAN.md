# Audio I/O Implementation Plan

> **Goal:** Enable browser-pilot to send custom audio into a page's microphone input and capture audio output — for automated testing of voice agent websites.

---

## Constraints & Design Decisions

| Constraint | Decision |
|---|---|
| browser-pilot connects to *already-running* browsers (providers) | Chrome launch flags alone won't work — need runtime JS injection as primary path, with launch flags as optional optimization |
| Zero production dependencies | All audio encoding/decoding done via Web Audio API inside the browser; no npm audio libs |
| Must work in headless Chrome | Use `--headless=new` (supports Web Audio); no `getDisplayMedia` (requires UI) |
| Must handle permissions | CDP `Browser.grantPermissions` + optional `--use-fake-ui-for-media-stream` flag |
| Voice agents may use `getUserMedia`, WebRTC, or Web Audio API | Must intercept at the `getUserMedia` level (covers all downstream consumers) |
| Need to change audio mid-session | Runtime injection (not just launch flags) — decode new audio buffers on demand |

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│  User Code                                               │
│                                                          │
│  // Input: feed audio to page's "microphone"             │
│  await page.audioInput.start('/path/to/prompt.wav');     │
│  // ...voice agent processes...                          │
│  await page.audioInput.stop();                           │
│                                                          │
│  // Output: capture what the page plays                  │
│  const capture = await page.audioOutput.start();         │
│  // ...wait for voice agent response...                  │
│  const pcmData = await page.audioOutput.stop();          │
│  // pcmData: Float32Array[] (per channel)                │
│                                                          │
│  // Convenience: full round-trip                         │
│  const response = await page.audioRoundTrip({            │
│    input: audioBytes,        // WAV/PCM ArrayBuffer      │
│    silenceTimeout: 3000,     // stop after 3s silence    │
│  });                                                     │
└───────────────┬──────────────────────────┬───────────────┘
                │                          │
    ┌───────────▼──────────┐   ┌───────────▼──────────┐
    │  AudioInput          │   │  AudioOutput         │
    │  (src/audio/input.ts)│   │  (src/audio/output.ts│
    │                      │   │                      │
    │  1. Grant mic perms  │   │  1. Inject capture   │
    │  2. Patch getUserMed │   │     script before    │
    │  3. Decode WAV/PCM   │   │     page load        │
    │  4. Feed via          │   │  2. Monkey-patch     │
    │     AudioContext →   │   │     AudioContext      │
    │     MediaStream      │   │     .destination      │
    │     Destination      │   │  3. Tap via           │
    │  5. Return patched   │   │     AudioWorklet     │
    │     stream from      │   │     (ScriptProcessor │
    │     getUserMedia     │   │      fallback)       │
    └──────────┬───────────┘   │  4. Buffer PCM data  │
               │               │  5. Transfer via      │
               │               │     Runtime.addBinding│
               ▼               └──────────┬────────────┘
    ┌──────────────────────┐              │
    │  CDP Commands        │◄─────────────┘
    │                      │
    │  - Browser.grant     │
    │    Permissions       │
    │  - Page.addScript    │
    │    ToEvaluateOn      │
    │    NewDocument       │
    │  - Runtime.evaluate  │
    │  - Runtime.addBinding│
    └──────────────────────┘
```

---

## Part 1: Permission Handling

### Problem
Voice agent sites call `navigator.mediaDevices.getUserMedia({ audio: true })`. This triggers a permission prompt that blocks automation.

### Solution: Three-layer permission grant

```
Layer 1: CDP Browser.grantPermissions  (works for connected browsers)
Layer 2: Chrome flag --use-fake-ui-for-media-stream  (when we control launch)
Layer 3: JS override of navigator.permissions.query  (belt-and-suspenders)
```

### Implementation

**File: `src/audio/permissions.ts`**

```typescript
export async function grantAudioPermissions(
  cdp: CDPClient,
  targetId: string,
  origin?: string
): Promise<void> {
  // 1. Grant via CDP (primary mechanism for connected browsers)
  await cdp.send('Browser.grantPermissions', {
    permissions: ['audioCapture'],  // CDP permission name for microphone
    origin: origin ?? '',           // empty = all origins
    // Note: no browserContextId needed for default context
  });

  // 2. Inject permissions.query override as safety net
  //    Some sites check permissions.query before calling getUserMedia
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      (function() {
        const origQuery = navigator.permissions.query.bind(navigator.permissions);
        navigator.permissions.query = async function(desc) {
          if (desc.name === 'microphone' || desc.name === 'audio-capture') {
            return { state: 'granted', onchange: null,
                     addEventListener: () => {},
                     removeEventListener: () => {} };
          }
          return origQuery(desc);
        };
      })();
    `,
  }, targetId);
}
```

### Validation
- Unit test: Mock CDP, verify `Browser.grantPermissions` is called with correct params
- Integration test: Navigate to a page that calls `navigator.permissions.query({name: 'microphone'})`, assert `state === 'granted'`
- Integration test: Call `getUserMedia({audio: true})` on a test page, assert no permission error thrown

---

## Part 2: Audio Input (Microphone Injection)

### Problem
Feed arbitrary audio bytes into the page so that `getUserMedia({audio: true})` returns a stream containing our audio instead of real microphone data.

### Approach: `getUserMedia` monkey-patch + Web Audio API decode

This is more flexible than Chrome's `--use-file-for-fake-audio-capture` flag because:
- Works on already-running browsers (provider-connected)
- Can change audio mid-session
- Can inject silence, then switch to real audio on demand
- Doesn't require WAV format (Web Audio API decodes WAV, MP3, OGG, etc.)

### Implementation

**File: `src/audio/input.ts`**

**Step 1: Inject the getUserMedia override (before page loads)**

The injected script does:
1. Store original `getUserMedia`
2. Replace with a version that returns our controlled `MediaStream`
3. Create an `AudioContext` + `MediaStreamDestinationNode` to produce the fake stream
4. Expose `window.__bpAudioInput` control interface for runtime commands

```typescript
const AUDIO_INPUT_INJECTION = `
(function() {
  // State
  let audioCtx = null;
  let sourceNode = null;
  let destinationNode = null;
  let fakeStream = null;
  let isPlaying = false;

  // Create the persistent fake stream (lazily, on first getUserMedia call)
  function ensureFakeStream() {
    if (fakeStream) return fakeStream;
    audioCtx = new AudioContext({ sampleRate: 48000 });
    destinationNode = audioCtx.createMediaStreamDestination();

    // Start with silence (OscillatorNode at 0 gain)
    const silence = audioCtx.createGain();
    silence.gain.value = 0;
    const osc = audioCtx.createOscillator();
    osc.connect(silence);
    silence.connect(destinationNode);
    osc.start();

    fakeStream = destinationNode.stream;
    return fakeStream;
  }

  // Play audio buffer into the fake stream
  async function playAudio(base64Data, sampleRate, numChannels) {
    ensureFakeStream();

    // Resume context if suspended (autoplay policy)
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    // Stop any currently playing source
    if (sourceNode) {
      try { sourceNode.stop(); } catch(e) {}
      sourceNode.disconnect();
    }

    // Decode the audio bytes
    const binaryStr = atob(base64Data);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer.slice(0));

    // Create source and connect to our fake stream destination
    sourceNode = audioCtx.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(destinationNode);

    return new Promise((resolve) => {
      sourceNode.onended = () => {
        isPlaying = false;
        resolve(true);
        // Notify Node.js side that playback finished
        if (window.__bpAudioInputDone) window.__bpAudioInputDone('done');
      };
      isPlaying = true;
      sourceNode.start();
    });
  }

  // Stop playback
  function stopAudio() {
    if (sourceNode) {
      try { sourceNode.stop(); } catch(e) {}
      sourceNode.disconnect();
      sourceNode = null;
    }
    isPlaying = false;
  }

  // Override getUserMedia
  const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
    navigator.mediaDevices
  );

  navigator.mediaDevices.getUserMedia = async function(constraints) {
    if (constraints && constraints.audio) {
      const stream = ensureFakeStream();

      // If video is also requested, get real video + our fake audio
      if (constraints.video) {
        const realStream = await origGetUserMedia({ video: constraints.video });
        const combined = new MediaStream([
          ...stream.getAudioTracks(),
          ...realStream.getVideoTracks(),
        ]);
        return combined;
      }

      return stream.clone();  // clone so consumers can't stop our source track
    }
    // No audio requested — passthrough
    return origGetUserMedia(constraints);
  };

  // Expose control interface
  window.__bpAudioInput = {
    play: playAudio,
    stop: stopAudio,
    isPlaying: () => isPlaying,
    getState: () => ({
      contextState: audioCtx?.state ?? 'not-created',
      isPlaying,
      sampleRate: audioCtx?.sampleRate ?? 0,
    }),
  };
})();
`;
```

**Step 2: Node.js-side AudioInput class**

```typescript
export interface AudioInputOptions {
  /** Sample rate for the fake audio context (default: 48000) */
  sampleRate?: number;
}

export interface PlayOptions {
  /** Wait for playback to complete before resolving (default: true) */
  waitForEnd?: boolean;
  /** Timeout in ms (default: 60000) */
  timeout?: number;
}

export class AudioInput {
  private cdp: CDPClient;
  private targetId: string;
  private injected = false;
  private bindingRegistered = false;

  constructor(cdp: CDPClient, targetId: string) { ... }

  /** Inject the getUserMedia override. Must be called before page navigates. */
  async setup(): Promise<void> {
    // 1. Grant permissions
    await grantAudioPermissions(this.cdp, this.targetId);

    // 2. Register binding for playback-complete callbacks
    if (!this.bindingRegistered) {
      await this.cdp.send('Runtime.addBinding', {
        name: '__bpAudioInputDone',
      }, this.targetId);
      this.bindingRegistered = true;
    }

    // 3. Inject script before any page JS runs
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: AUDIO_INPUT_INJECTION,
    }, this.targetId);

    this.injected = true;
  }

  /**
   * Play audio bytes into the page's fake microphone.
   * Accepts WAV, MP3, OGG — anything Web Audio API can decode.
   */
  async play(
    audioData: ArrayBuffer | Uint8Array | Buffer,
    options?: PlayOptions
  ): Promise<void> {
    if (!this.injected) throw new Error('AudioInput not set up. Call setup() first.');

    const base64 = bufferToBase64(audioData);
    const waitForEnd = options?.waitForEnd ?? true;
    const timeout = options?.timeout ?? 60000;

    if (waitForEnd) {
      // Wait for the binding callback
      const donePromise = this.waitForBinding('__bpAudioInputDone', timeout);
      await this.cdp.send('Runtime.evaluate', {
        expression: `window.__bpAudioInput.play('${base64}')`,
        awaitPromise: true,
      }, this.targetId);
      await donePromise;
    } else {
      await this.cdp.send('Runtime.evaluate', {
        expression: `window.__bpAudioInput.play('${base64}')`,
        awaitPromise: false,  // fire-and-forget
      }, this.targetId);
    }
  }

  /** Stop any currently playing audio */
  async stop(): Promise<void> { ... }

  /** Get current state of the injected audio system */
  async getState(): Promise<AudioInputState> { ... }

  /** Clean up resources */
  async teardown(): Promise<void> { ... }
}
```

### Handling Large Audio Files

Audio files can be large. Sending a 30-second WAV at 48kHz stereo 16-bit = ~5.5MB base64 string. This is within CDP's message size limit (~100MB) but warrants chunking for very long files:

```typescript
// For files > 4MB, chunk and reassemble in-browser
async playLargeFile(audioData: ArrayBuffer): Promise<void> {
  const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB chunks
  if (audioData.byteLength <= CHUNK_SIZE * 2) {
    return this.play(audioData);  // small enough, direct send
  }

  // Send chunks via Runtime.evaluate, accumulate in browser
  const totalChunks = Math.ceil(audioData.byteLength / CHUNK_SIZE);
  await this.cdp.send('Runtime.evaluate', {
    expression: `window.__bpAudioChunks = []; window.__bpAudioChunkCount = ${totalChunks};`,
  }, this.targetId);

  for (let i = 0; i < totalChunks; i++) {
    const chunk = audioData.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const b64 = bufferToBase64(chunk);
    await this.cdp.send('Runtime.evaluate', {
      expression: `window.__bpAudioChunks.push('${b64}');`,
    }, this.targetId);
  }

  // Reassemble and play in-browser
  await this.cdp.send('Runtime.evaluate', {
    expression: `
      (async () => {
        const full = window.__bpAudioChunks.join('');
        delete window.__bpAudioChunks;
        await window.__bpAudioInput.play(full);
      })()
    `,
    awaitPromise: true,
  }, this.targetId);
}
```

---

## Part 3: Audio Output (Capture)

### Problem
Capture audio that the voice agent plays back — whether via `<audio>` elements, Web Audio API, WebRTC, or `speechSynthesis`.

### Approach: Multi-vector capture via JS injection

We need to intercept audio at multiple levels since voice agents use different playback methods:

```
Vector 1: AudioContext.destination monkey-patch
          (catches Web Audio API output)

Vector 2: HTMLMediaElement.prototype.play monkey-patch + captureStream()
          (catches <audio> and <video> elements)

Vector 3: speechSynthesis monkey-patch
          (catches browser text-to-speech — less common but possible)

All vectors → ScriptProcessorNode/AudioWorklet → PCM buffer → Runtime.addBinding → Node.js
```

### Implementation

**File: `src/audio/output.ts`**

**Step 1: Capture injection script**

```typescript
const AUDIO_OUTPUT_INJECTION = `
(function() {
  const BUFFER_SIZE = 4096;
  let captureCtx = null;
  let processor = null;
  let capturing = false;
  let capturedChunks = [];     // Array of Float32Array per chunk
  let totalSamples = 0;
  let channelCount = 2;

  // ---- Vector 1: AudioContext.destination interception ----
  const OrigAudioContext = window.AudioContext || window.webkitAudioContext;
  const origConnect = AudioNode.prototype.connect;

  AudioNode.prototype.connect = function(destination, ...args) {
    const result = origConnect.call(this, destination, ...args);

    // If connecting to a destination node, also tap it
    if (capturing && destination instanceof AudioDestinationNode) {
      try {
        origConnect.call(this, processor, ...args);
      } catch(e) {
        // Ignore if already connected or incompatible
      }
    }
    return result;
  };

  // ---- Vector 2: HTMLMediaElement capture ----
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function() {
    if (capturing && !this.__bpCaptured) {
      this.__bpCaptured = true;
      try {
        const stream = this.captureStream();
        if (!captureCtx) initCapture();
        const source = captureCtx.createMediaStreamSource(stream);
        source.connect(processor);
      } catch(e) {
        // captureStream may not be available in all contexts
      }
    }
    return origPlay.call(this);
  };

  // ---- Capture engine ----
  function initCapture() {
    captureCtx = new OrigAudioContext({ sampleRate: 48000 });
    // ScriptProcessorNode: deprecated but universally supported and simpler
    // AudioWorklet alternative provided below
    processor = captureCtx.createScriptProcessor(BUFFER_SIZE, 2, 2);
    processor.onaudioprocess = (e) => {
      if (!capturing) return;
      const left = new Float32Array(e.inputBuffer.getChannelData(0));
      const right = new Float32Array(e.inputBuffer.getChannelData(1));
      capturedChunks.push({ left, right });
      totalSamples += left.length;

      // Periodic flush to Node.js (every ~1 second of audio at 48kHz)
      if (totalSamples >= 48000) {
        flushToNodeJs();
      }
    };
    processor.connect(captureCtx.destination);  // must be connected to keep running
  }

  function flushToNodeJs() {
    if (capturedChunks.length === 0) return;

    // Merge chunks
    const totalLen = capturedChunks.reduce((s, c) => s + c.left.length, 0);
    const left = new Float32Array(totalLen);
    const right = new Float32Array(totalLen);
    let offset = 0;
    for (const chunk of capturedChunks) {
      left.set(chunk.left, offset);
      right.set(chunk.right, offset);
      offset += chunk.left.length;
    }

    // Convert to base64 for transfer
    const leftBytes = new Uint8Array(left.buffer);
    const rightBytes = new Uint8Array(right.buffer);

    // Use binding to send back to Node.js
    const leftB64 = btoa(String.fromCharCode(...leftBytes));
    const rightB64 = btoa(String.fromCharCode(...rightBytes));

    if (window.__bpAudioOutputData) {
      window.__bpAudioOutputData(JSON.stringify({
        left: leftB64,
        right: rightB64,
        sampleRate: captureCtx.sampleRate,
        samples: totalLen,
      }));
    }

    capturedChunks = [];
    totalSamples = 0;
  }

  // ---- Control interface ----
  window.__bpAudioOutput = {
    start: () => {
      if (!captureCtx) initCapture();
      capturing = true;
      capturedChunks = [];
      totalSamples = 0;
    },
    stop: () => {
      capturing = false;
      flushToNodeJs();  // flush remaining
    },
    isCapturing: () => capturing,
    getBufferedSamples: () => totalSamples,
  };
})();
`;
```

**Step 2: Node.js-side AudioOutput class**

```typescript
export interface AudioChunk {
  /** Left channel PCM data (Float32) */
  left: Float32Array;
  /** Right channel PCM data (Float32) */
  right: Float32Array;
  /** Sample rate */
  sampleRate: number;
  /** Number of samples in this chunk */
  samples: number;
  /** Timestamp when this chunk was received */
  timestamp: number;
}

export interface CaptureResult {
  /** All captured PCM data, left channel */
  left: Float32Array;
  /** All captured PCM data, right channel */
  right: Float32Array;
  /** Sample rate */
  sampleRate: number;
  /** Total duration in seconds */
  durationMs: number;
  /** Number of chunks received */
  chunkCount: number;
}

export interface CaptureOptions {
  /** Stop after N ms of silence (RMS below threshold). Default: 0 (manual stop) */
  silenceTimeout?: number;
  /** RMS threshold to consider as silence. Default: 0.01 */
  silenceThreshold?: number;
  /** Maximum capture duration in ms. Default: 300000 (5 min) */
  maxDuration?: number;
}

export class AudioOutput {
  private cdp: CDPClient;
  private targetId: string;
  private chunks: AudioChunk[] = [];
  private injected = false;
  private capturing = false;
  private onChunk?: (chunk: AudioChunk) => void;

  constructor(cdp: CDPClient, targetId: string) { ... }

  async setup(): Promise<void> {
    // Register binding for receiving audio data
    await this.cdp.send('Runtime.addBinding', {
      name: '__bpAudioOutputData',
    }, this.targetId);

    // Listen for binding calls
    this.cdp.on('Runtime.bindingCalled', (params) => {
      if (params.name === '__bpAudioOutputData') {
        this.handleAudioData(params.payload);
      }
    });

    // Inject capture script
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: AUDIO_OUTPUT_INJECTION,
    }, this.targetId);

    this.injected = true;
  }

  /** Start capturing audio output */
  async start(options?: CaptureOptions): Promise<void> {
    this.chunks = [];
    this.capturing = true;

    await this.cdp.send('Runtime.evaluate', {
      expression: 'window.__bpAudioOutput.start()',
    }, this.targetId);
  }

  /** Stop capturing, return all collected audio */
  async stop(): Promise<CaptureResult> {
    await this.cdp.send('Runtime.evaluate', {
      expression: 'window.__bpAudioOutput.stop()',
    }, this.targetId);

    this.capturing = false;

    // Small delay to ensure final flush arrives
    await sleep(200);

    return this.mergeChunks();
  }

  /**
   * Capture until silence is detected.
   * Resolves when `silenceTimeout` ms of consecutive silence pass.
   */
  async captureUntilSilence(options: CaptureOptions): Promise<CaptureResult> {
    const silenceTimeout = options.silenceTimeout ?? 3000;
    const silenceThreshold = options.silenceThreshold ?? 0.01;
    const maxDuration = options.maxDuration ?? 300000;

    await this.start(options);

    return new Promise((resolve, reject) => {
      let lastSoundTime = Date.now();
      const startTime = Date.now();

      const checkInterval = setInterval(async () => {
        // Check max duration
        if (Date.now() - startTime > maxDuration) {
          clearInterval(checkInterval);
          resolve(await this.stop());
          return;
        }

        // Analyze latest chunk for silence
        const latest = this.chunks[this.chunks.length - 1];
        if (latest) {
          const rms = calculateRMS(latest.left);
          if (rms > silenceThreshold) {
            lastSoundTime = Date.now();
          }
        }

        // Check silence timeout
        if (Date.now() - lastSoundTime > silenceTimeout) {
          clearInterval(checkInterval);
          resolve(await this.stop());
        }
      }, 200);  // Check every 200ms
    });
  }

  /** Subscribe to real-time audio chunks */
  onData(handler: (chunk: AudioChunk) => void): void {
    this.onChunk = handler;
  }

  private handleAudioData(payload: string): void {
    const data = JSON.parse(payload);
    const chunk = decodeAudioChunk(data);
    this.chunks.push(chunk);
    this.onChunk?.(chunk);
  }

  private mergeChunks(): CaptureResult { ... }
}
```

### Performance: Base64 Transfer Overhead

Transferring PCM as base64 through CDP bindings is ~33% overhead. For real-time voice (mono 48kHz float32 = ~192KB/sec raw = ~256KB/sec base64), this is acceptable. For long recordings, consider:

1. Flushing every 1 second (already in the design)
2. Converting to 16-bit PCM in-browser before transfer (halves size)
3. For captures > 60 seconds, write to IndexedDB in-browser and download via CDP `IO.read`

This optimization can be deferred — the base64 path works fine for voice agent testing sessions (typically < 60 seconds per interaction).

---

## Part 4: Convenience API — `audioRoundTrip()`

The most common use case for voice agent testing is:
1. Start capturing output
2. Feed input audio (the "prompt")
3. Wait for the agent to finish speaking (silence detection)
4. Return the agent's audio response

**File: `src/audio/roundtrip.ts`**

```typescript
export interface RoundTripOptions {
  /** Audio data to send as microphone input (WAV, MP3, etc.) */
  input: ArrayBuffer | Uint8Array;
  /** Ms of silence before considering the agent "done talking". Default: 3000 */
  silenceTimeout?: number;
  /** RMS threshold for silence. Default: 0.01 */
  silenceThreshold?: number;
  /** Max total time for the round trip. Default: 120000 (2 min) */
  timeout?: number;
  /** Delay before starting input playback (let page initialize). Default: 0 */
  preDelay?: number;
}

export interface RoundTripResult {
  /** Captured audio response */
  audio: CaptureResult;
  /** Time from input start to first non-silent output chunk */
  latencyMs: number;
  /** Total round-trip time */
  totalMs: number;
}

// Implementation on Page class:
async audioRoundTrip(options: RoundTripOptions): Promise<RoundTripResult> {
  const start = Date.now();

  // Start capturing output first
  await this.audioOutput.start();

  // Optional delay for page initialization
  if (options.preDelay) await sleep(options.preDelay);

  // Feed input audio (don't wait for completion — agent may start
  // responding before input finishes)
  const inputPromise = this.audioInput.play(options.input, { waitForEnd: false });

  // Wait for agent response + silence
  const audio = await this.audioOutput.captureUntilSilence({
    silenceTimeout: options.silenceTimeout ?? 3000,
    silenceThreshold: options.silenceThreshold ?? 0.01,
    maxDuration: options.timeout ?? 120000,
  });

  // Ensure input playback is cleaned up
  await this.audioInput.stop();

  return {
    audio,
    latencyMs: audio.chunkCount > 0
      ? (this.audioOutput.firstChunkTime! - start)
      : -1,
    totalMs: Date.now() - start,
  };
}
```

---

## Part 5: Page Class Integration

### New methods on `Page`

```typescript
// In src/browser/page.ts — add as lazy-initialized properties

class Page {
  private _audioInput?: AudioInput;
  private _audioOutput?: AudioOutput;

  /** Audio input control (fake microphone) */
  get audioInput(): AudioInput {
    if (!this._audioInput) {
      this._audioInput = new AudioInput(this.cdp, this.targetId);
    }
    return this._audioInput;
  }

  /** Audio output capture */
  get audioOutput(): AudioOutput {
    if (!this._audioOutput) {
      this._audioOutput = new AudioOutput(this.cdp, this.targetId);
    }
    return this._audioOutput;
  }

  /** Convenience: set up both audio input and output */
  async setupAudio(): Promise<void> {
    await this.audioInput.setup();
    await this.audioOutput.setup();
  }

  /** Full audio round-trip (send prompt, capture response) */
  async audioRoundTrip(options: RoundTripOptions): Promise<RoundTripResult> {
    if (!this._audioInput || !this._audioOutput) {
      await this.setupAudio();
    }
    // ... implementation from Part 4
  }
}
```

### Batch execution integration

Add new action types to `src/actions/types.ts`:

```typescript
// New ActionTypes
'setupAudio'     // Initialize audio I/O
'playAudio'      // Feed audio into microphone
'startCapture'   // Start capturing audio output
'stopCapture'    // Stop capturing and return result

// New Step fields
interface Step {
  // ... existing fields ...
  /** Audio data as base64 (for playAudio action) */
  audioData?: string;
  /** Audio capture options */
  captureOptions?: CaptureOptions;
}
```

---

## Part 6: File Structure

```
src/audio/
├── index.ts          # Re-exports
├── types.ts          # AudioChunk, CaptureResult, RoundTripOptions, etc.
├── permissions.ts    # grantAudioPermissions()
├── input.ts          # AudioInput class + injection script
├── output.ts         # AudioOutput class + injection script
├── roundtrip.ts      # audioRoundTrip() logic
└── encoding.ts       # bufferToBase64, decodeAudioChunk, calculateRMS,
                      # WAV header parsing/generation utilities
```

---

## Part 7: Launch Flags Integration (Optional Optimization)

For users who control the browser launch (local testing via `chrome-launcher`), we can offer an optimized path with Chrome's native fake device support.

**File: `src/audio/flags.ts`**

```typescript
/**
 * Chrome flags for audio automation.
 * Use these when launching Chrome yourself (not connecting to remote).
 */
export function getAudioChromeFlags(options?: {
  /** Path to WAV file for fake microphone input */
  inputWavPath?: string;
  /** Disable looping of the input file */
  noLoop?: boolean;
}): string[] {
  const flags = [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ];

  if (options?.inputWavPath) {
    let path = options.inputWavPath;
    if (options.noLoop) path += '%noloop';
    flags.push(`--use-file-for-fake-audio-capture=${path}`);
  }

  return flags;
}
```

Update the test harness to use these flags when running audio integration tests.

---

## Part 8: Encoding Utilities

**File: `src/audio/encoding.ts`**

Zero-dependency utilities for working with audio data:

```typescript
/** Convert ArrayBuffer/Uint8Array to base64 string */
export function bufferToBase64(data: ArrayBuffer | Uint8Array): string { ... }

/** Decode base64 to Uint8Array */
export function base64ToBuffer(b64: string): Uint8Array { ... }

/** Decode a base64-encoded Float32Array PCM chunk */
export function decodeAudioChunk(data: {
  left: string; right: string; sampleRate: number; samples: number;
}): AudioChunk { ... }

/** Calculate RMS (root mean square) of a Float32Array — for silence detection */
export function calculateRMS(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Generate a minimal WAV file from PCM data.
 * Useful for saving captured audio to disk.
 */
export function pcmToWav(options: {
  left: Float32Array;
  right?: Float32Array;
  sampleRate: number;
}): ArrayBuffer { ... }

/**
 * Parse a WAV file header to extract metadata.
 */
export function parseWavHeader(data: ArrayBuffer): {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
} { ... }

/**
 * Generate silence as Float32Array (for padding/testing).
 */
export function generateSilence(durationMs: number, sampleRate = 48000): Float32Array {
  return new Float32Array(Math.ceil(sampleRate * durationMs / 1000));
}

/**
 * Generate a sine wave tone (for testing audio pipeline).
 */
export function generateTone(
  frequency: number,
  durationMs: number,
  sampleRate = 48000,
  amplitude = 0.5
): Float32Array { ... }
```

---

## Part 9: Validation & Testing Strategy

### Unit Tests (`tests/unit/audio/`)

These mock the CDP client and verify the correct CDP commands are sent.

**`tests/unit/audio/permissions.test.ts`**
```typescript
test('grants microphone permission via CDP', async () => {
  const mockCdp = createMockCDP();
  await grantAudioPermissions(mockCdp, 'target-1');
  expect(mockCdp.sent).toContainEqual({
    method: 'Browser.grantPermissions',
    params: { permissions: ['audioCapture'], origin: '' },
  });
});

test('injects permissions.query override', async () => {
  const mockCdp = createMockCDP();
  await grantAudioPermissions(mockCdp, 'target-1');
  expect(mockCdp.sent).toContainEqual(
    expect.objectContaining({
      method: 'Page.addScriptToEvaluateOnNewDocument',
    })
  );
});
```

**`tests/unit/audio/input.test.ts`**
```typescript
test('setup injects getUserMedia override', async () => { ... });
test('play sends base64-encoded audio via Runtime.evaluate', async () => { ... });
test('play with waitForEnd=true waits for binding callback', async () => { ... });
test('play with waitForEnd=false returns immediately', async () => { ... });
test('stop calls sourceNode.stop() in browser', async () => { ... });
test('throws if play called before setup', async () => { ... });
test('handles large files via chunking', async () => { ... });
```

**`tests/unit/audio/output.test.ts`**
```typescript
test('setup registers Runtime.addBinding', async () => { ... });
test('start calls __bpAudioOutput.start() in browser', async () => { ... });
test('handles incoming audio chunks via binding', async () => { ... });
test('stop flushes and merges all chunks', async () => { ... });
test('captureUntilSilence resolves after silence threshold', async () => { ... });
test('captureUntilSilence respects maxDuration', async () => { ... });
test('onData callback fires for each chunk', async () => { ... });
```

**`tests/unit/audio/encoding.test.ts`**
```typescript
test('bufferToBase64 round-trips correctly', () => { ... });
test('calculateRMS returns 0 for silence', () => {
  const silence = new Float32Array(1000);
  expect(calculateRMS(silence)).toBe(0);
});
test('calculateRMS returns correct value for known signal', () => {
  // A constant signal of 0.5 should have RMS of 0.5
  const signal = new Float32Array(1000).fill(0.5);
  expect(calculateRMS(signal)).toBeCloseTo(0.5);
});
test('pcmToWav produces valid WAV header', () => { ... });
test('parseWavHeader extracts correct metadata', () => { ... });
test('generateTone produces correct frequency', () => {
  const tone = generateTone(440, 1000, 48000);
  expect(tone.length).toBe(48000);
  // Verify zero-crossings match expected frequency
  let crossings = 0;
  for (let i = 1; i < tone.length; i++) {
    if (tone[i - 1] < 0 && tone[i] >= 0) crossings++;
  }
  expect(crossings).toBeCloseTo(440, -1);  // ~440 zero crossings per second
});
```

### Integration Tests (`tests/integration/audio/`)

These use a real browser with test fixture pages.

**Test fixtures needed:**

`tests/fixtures/pages/audio-input.html`
```html
<!-- Page that calls getUserMedia and displays audio stats -->
<div id="status">waiting</div>
<div id="rms">0</div>
<script>
  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      document.getElementById('status').textContent = 'streaming';

      // Analyze the input stream
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      source.connect(analyser);

      const data = new Float32Array(analyser.fftSize);
      function tick() {
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        document.getElementById('rms').textContent = rms.toFixed(6);
        if (rms > 0.01) {
          document.getElementById('status').textContent = 'audio-detected';
        }
        requestAnimationFrame(tick);
      }
      tick();
    } catch (e) {
      document.getElementById('status').textContent = 'error: ' + e.message;
    }
  }
  start();
</script>
```

`tests/fixtures/pages/audio-output.html`
```html
<!-- Page that plays a known tone via Web Audio API -->
<div id="status">waiting</div>
<button id="play" onclick="playTone()">Play</button>
<script>
  function playTone() {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;  // A4 note
    const gain = ctx.createGain();
    gain.gain.value = 0.5;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    document.getElementById('status').textContent = 'playing';
    setTimeout(() => {
      osc.stop();
      document.getElementById('status').textContent = 'stopped';
    }, 2000);
  }
</script>
```

`tests/fixtures/pages/audio-element.html`
```html
<!-- Page that plays audio via <audio> element -->
<audio id="player" src="/test-tone.wav"></audio>
<div id="status">waiting</div>
<script>
  document.getElementById('player').onplay = () => {
    document.getElementById('status').textContent = 'playing';
  };
  document.getElementById('player').onended = () => {
    document.getElementById('status').textContent = 'ended';
  };
</script>
```

**Integration test cases:**

```typescript
// tests/integration/audio/permissions.test.ts
test('grants microphone permission before page load', async () => {
  await page.setupAudio();
  await page.goto(`${baseUrl}/audio-input.html`);
  const status = await page.text('#status');
  expect(status).toBe('streaming');  // NOT 'error: Permission denied'
});

// tests/integration/audio/input.test.ts
test('injected audio is received by getUserMedia consumer', async () => {
  await page.setupAudio();
  await page.goto(`${baseUrl}/audio-input.html`);

  // Generate a 440Hz tone, 1 second, as WAV
  const tone = generateTone(440, 1000, 48000);
  const wav = pcmToWav({ left: tone, sampleRate: 48000 });

  await page.audioInput.play(wav);

  // The page measures RMS of the input — should detect non-silence
  const status = await page.text('#status');
  expect(status).toBe('audio-detected');

  const rms = parseFloat(await page.text('#rms'));
  expect(rms).toBeGreaterThan(0.01);
});

test('can change audio input mid-session', async () => {
  await page.setupAudio();
  await page.goto(`${baseUrl}/audio-input.html`);

  // Play silence first
  const silence = generateSilence(500, 48000);
  const silenceWav = pcmToWav({ left: silence, sampleRate: 48000 });
  await page.audioInput.play(silenceWav);

  let rms = parseFloat(await page.text('#rms'));
  expect(rms).toBeLessThan(0.01);

  // Now play a tone
  const tone = generateTone(440, 1000, 48000);
  const toneWav = pcmToWav({ left: tone, sampleRate: 48000 });
  await page.audioInput.play(toneWav);

  rms = parseFloat(await page.text('#rms'));
  expect(rms).toBeGreaterThan(0.01);
});

// tests/integration/audio/output.test.ts
test('captures Web Audio API output', async () => {
  await page.setupAudio();
  await page.goto(`${baseUrl}/audio-output.html`);

  await page.audioOutput.start();
  await page.click('#play');

  // Wait for the tone to play (2 seconds) + buffer
  await sleep(2500);

  const result = await page.audioOutput.stop();
  expect(result.durationMs).toBeGreaterThan(1500);
  expect(result.durationMs).toBeLessThan(3000);

  // Verify captured audio is non-silent
  const rms = calculateRMS(result.left);
  expect(rms).toBeGreaterThan(0.01);
});

test('captures <audio> element output', async () => {
  await page.setupAudio();
  await page.goto(`${baseUrl}/audio-element.html`);

  await page.audioOutput.start();
  await page.evaluate('document.getElementById("player").play()');

  const result = await page.audioOutput.captureUntilSilence({
    silenceTimeout: 1000,
  });

  expect(result.left.length).toBeGreaterThan(0);
});

test('captureUntilSilence stops after silence threshold', async () => {
  await page.setupAudio();
  await page.goto(`${baseUrl}/audio-output.html`);

  // The page plays a 2-second tone then stops
  await page.click('#play');

  const result = await page.audioOutput.captureUntilSilence({
    silenceTimeout: 1500,
    silenceThreshold: 0.01,
  });

  // Should capture ~2s of audio + 1.5s of silence detection
  expect(result.durationMs).toBeGreaterThan(2000);
  expect(result.durationMs).toBeLessThan(5000);
});

// tests/integration/audio/roundtrip.test.ts
test('full audio round-trip with echo page', async () => {
  // Create a test page that echoes microphone input back as output
  // (connects getUserMedia stream directly to AudioContext.destination)
  await page.setupAudio();
  await page.goto(`${baseUrl}/audio-echo.html`);

  const tone = generateTone(440, 1000, 48000);
  const wav = pcmToWav({ left: tone, sampleRate: 48000 });

  const result = await page.audioRoundTrip({
    input: wav,
    silenceTimeout: 2000,
  });

  expect(result.audio.left.length).toBeGreaterThan(0);
  expect(result.latencyMs).toBeGreaterThan(0);
  expect(result.latencyMs).toBeLessThan(1000);  // should respond quickly
});
```

### Additional test fixture needed:

`tests/fixtures/pages/audio-echo.html`
```html
<!-- Echoes microphone input to speaker output (for round-trip testing) -->
<div id="status">waiting</div>
<script>
  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      source.connect(ctx.destination);
      document.getElementById('status').textContent = 'echoing';
    } catch (e) {
      document.getElementById('status').textContent = 'error: ' + e.message;
    }
  }
  start();
</script>
```

### Test Harness Updates

```typescript
// tests/utils/harness.ts — add audio harness variant
export async function createAudioTestHarness(): Promise<TestHarness> {
  const server = Bun.serve({ ... });  // same as existing

  const chrome = await chromeLauncher.launch({
    chromeFlags: [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',  // allow audio autoplay
      // NOT --mute-audio (we need audio processing to work)
      // NOT --use-fake-device-for-media-stream (we handle this in JS)
    ],
    userDataDir: false,
  });

  const wsUrl = await getBrowserWebSocketUrl(`localhost:${chrome.port}`);
  const browser = await connect({ provider: 'generic', wsUrl });

  return { browser, baseUrl: `http://localhost:${server.port}`, chrome, server };
}
```

---

## Part 10: Implementation Order

| Phase | What | Files | Tests |
|-------|------|-------|-------|
| **1** | Encoding utilities | `src/audio/encoding.ts`, `src/audio/types.ts` | `tests/unit/audio/encoding.test.ts` |
| **2** | Permission handling | `src/audio/permissions.ts` | `tests/unit/audio/permissions.test.ts`, `tests/integration/audio/permissions.test.ts` |
| **3** | Audio input (microphone injection) | `src/audio/input.ts` | `tests/unit/audio/input.test.ts`, `tests/integration/audio/input.test.ts` |
| **4** | Audio output (capture) | `src/audio/output.ts` | `tests/unit/audio/output.test.ts`, `tests/integration/audio/output.test.ts` |
| **5** | Round-trip convenience + Page integration | `src/audio/roundtrip.ts`, page.ts changes | `tests/integration/audio/roundtrip.test.ts` |
| **6** | Launch flags helper + test harness updates | `src/audio/flags.ts`, harness updates | harness test |
| **7** | Batch execution integration | `src/actions/types.ts`, executor changes | `tests/unit/audio/batch.test.ts` |
| **8** | Exports + documentation | `src/audio/index.ts`, `src/index.ts` | — |

---

## Edge Cases & Robustness

### What if the page creates AudioContext before our injection runs?

`Page.addScriptToEvaluateOnNewDocument` runs before **any** page script, so this shouldn't happen. However, as a safety net, also call `Runtime.evaluate` with the injection script immediately after navigation if `setupAudio()` is called post-navigation.

### What if the page's AudioContext has a different sample rate?

The injected audio is decoded by `AudioContext.decodeAudioData()`, which handles sample rate conversion automatically. The capture uses its own AudioContext at 48kHz — any connected sources are resampled by the browser.

### What if getUserMedia is called multiple times?

The injected override always returns a clone of the same underlying `MediaStream`. Each consumer gets its own track reference but they all receive the same audio data. This matches how a real microphone works.

### What if the page uses WebRTC (RTCPeerConnection)?

WebRTC gets its audio from `getUserMedia` streams. Since we intercept at the `getUserMedia` level, WebRTC-based voice agents receive our injected audio automatically. No special handling needed.

### What about Content Security Policy (CSP)?

`Page.addScriptToEvaluateOnNewDocument` executes in the page's context but is not subject to CSP `script-src` restrictions (it's injected by the browser, not loaded from a URL). This is the same mechanism Puppeteer uses.

### What if the voice agent uses WebSocket for audio transport?

Some voice agents stream audio over WebSocket (not Web Audio API for output). For these cases, the user can combine `page.audioInput` with the existing `page.intercept()` to capture WebSocket frames. This is an advanced use case that doesn't need first-class support.

### What about `navigator.mediaDevices.enumerateDevices()`?

Some voice agents check for available devices before requesting them. We should patch `enumerateDevices` to return a fake microphone device:

```javascript
// Add to AUDIO_INPUT_INJECTION
const origEnumerate = navigator.mediaDevices.enumerateDevices.bind(
  navigator.mediaDevices
);
navigator.mediaDevices.enumerateDevices = async function() {
  const devices = await origEnumerate();
  const hasMic = devices.some(d => d.kind === 'audioinput');
  if (!hasMic) {
    devices.push({
      deviceId: 'bp-fake-mic',
      kind: 'audioinput',
      label: 'Default Audio Input',
      groupId: 'bp-audio',
      toJSON() { return { deviceId: this.deviceId, kind: this.kind, label: this.label, groupId: this.groupId }; },
    });
  }
  return devices;
};
```
