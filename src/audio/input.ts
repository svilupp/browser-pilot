/**
 * AudioInput — inject audio into a page's fake microphone
 *
 * Monkey-patches navigator.mediaDevices.getUserMedia to return a
 * controlled MediaStream fed by an AudioContext. Supports playing
 * arbitrary audio (WAV, MP3, OGG) and changing audio mid-session.
 */

import type { CDPClient } from '../cdp/client.ts';
import { bufferToBase64 } from './encoding.ts';
import { grantAudioPermissions } from './permissions.ts';
import type { AudioInputState, PlayOptions } from './types.ts';

/** Binding name for playback-complete callbacks */
const INPUT_BINDING = '__bpAudioInputDone';

/**
 * JS script injected into the page to override getUserMedia.
 *
 * Exposes window.__bpAudioInput with play/stop/getState methods.
 * Creates a persistent fake MediaStream backed by a MediaStreamDestinationNode.
 */
const AUDIO_INPUT_SCRIPT = `
(function() {
  if (window.__bpAudioInput) return;

  var audioCtx = null;
  var sourceNode = null;
  var destinationNode = null;
  var fakeStream = null;
  var silenceGain = null;
  var silenceOsc = null;
  var isPlaying = false;

  function ensureFakeStream() {
    if (fakeStream) return fakeStream;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    destinationNode = audioCtx.createMediaStreamDestination();

    // Start with silence so the stream always has active tracks
    silenceGain = audioCtx.createGain();
    silenceGain.gain.value = 0;
    silenceOsc = audioCtx.createOscillator();
    silenceOsc.connect(silenceGain);
    silenceGain.connect(destinationNode);
    silenceOsc.start();

    fakeStream = destinationNode.stream;
    return fakeStream;
  }

  function playAudio(base64Data) {
    ensureFakeStream();

    var resumePromise = audioCtx.state === 'suspended'
      ? audioCtx.resume()
      : Promise.resolve();

    return resumePromise.then(function() {
      if (sourceNode) {
        try { sourceNode.stop(); } catch(e) {}
        sourceNode.disconnect();
        sourceNode = null;
      }

      var binaryStr = atob(base64Data);
      var bytes = new Uint8Array(binaryStr.length);
      for (var i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      return audioCtx.decodeAudioData(bytes.buffer.slice(0));
    }).then(function(audioBuffer) {
      sourceNode = audioCtx.createBufferSource();
      sourceNode.buffer = audioBuffer;
      sourceNode.connect(destinationNode);

      return new Promise(function(resolve) {
        sourceNode.onended = function() {
          isPlaying = false;
          resolve(true);
          try {
            if (typeof window.__bpAudioInputDone === 'function') {
              window.__bpAudioInputDone('done');
            }
          } catch(e) {}
        };
        isPlaying = true;
        sourceNode.start();
      });
    });
  }

  function stopAudio() {
    if (sourceNode) {
      try { sourceNode.stop(); } catch(e) {}
      sourceNode.disconnect();
      sourceNode = null;
    }
    isPlaying = false;
  }

  var origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  navigator.mediaDevices.getUserMedia = function(constraints) {
    if (constraints && constraints.audio) {
      var stream = ensureFakeStream();

      if (constraints.video) {
        // Get real video + our fake audio
        return origGetUserMedia({ video: constraints.video }).then(function(realStream) {
          var combined = new MediaStream(
            stream.getAudioTracks().concat(realStream.getVideoTracks())
          );
          return combined;
        });
      }

      // Return a clone so consumers can't stop our source track
      return Promise.resolve(stream.clone());
    }
    return origGetUserMedia(constraints);
  };

  var origEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
  navigator.mediaDevices.enumerateDevices = function() {
    return origEnumerate().then(function(devices) {
      var hasMic = devices.some(function(d) { return d.kind === 'audioinput'; });
      if (!hasMic) {
        devices.push({
          deviceId: 'bp-fake-mic',
          kind: 'audioinput',
          label: 'Default Audio Input',
          groupId: 'bp-audio',
          toJSON: function() {
            return { deviceId: this.deviceId, kind: this.kind, label: this.label, groupId: this.groupId };
          }
        });
      }
      return devices;
    });
  };

  window.__bpAudioInput = {
    play: playAudio,
    stop: stopAudio,
    isPlaying: function() { return isPlaying; },
    getState: function() {
      return {
        contextState: audioCtx ? audioCtx.state : 'not-created',
        isPlaying: isPlaying,
        sampleRate: audioCtx ? audioCtx.sampleRate : 0
      };
    }
  };
})();
`;

export class AudioInput {
  private cdp: CDPClient;
  private injected = false;
  private bindingRegistered = false;
  private bindingHandler: ((params: Record<string, unknown>) => void) | null = null;

  constructor(cdp: CDPClient) {
    this.cdp = cdp;
  }

  /** Whether the audio input system has been set up */
  get isSetup(): boolean {
    return this.injected;
  }

  /**
   * Set up audio input injection.
   * Must be called before navigating to the page that will use getUserMedia.
   * Grants permissions and injects the getUserMedia override.
   */
  async setup(): Promise<void> {
    if (this.injected) return;

    // Validate we're on a real page (not about:blank)
    try {
      const resp = (await this.cdp.send('Runtime.evaluate', {
        expression: 'location.href',
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      const href = resp.result?.value;
      if (typeof href === 'string' && (href === 'about:blank' || href === 'about:srcdoc')) {
        throw new Error(
          'Cannot set up audio on about:blank. Navigate to a page first.\n' +
            'Example: await page.goto("https://your-voice-app.com")'
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('Cannot set up audio')) throw e;
      // Fall through for other errors
    }

    // Get current page origin for permission grant
    let origin: string | undefined;
    try {
      const resp = (await this.cdp.send('Runtime.evaluate', {
        expression: 'location.origin',
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      const val = resp.result?.value;
      if (typeof val === 'string' && val !== 'null') {
        origin = val;
      }
    } catch {
      // Fall through — will try without origin
    }
    await grantAudioPermissions(this.cdp, origin);

    if (!this.bindingRegistered) {
      await this.cdp.send('Runtime.addBinding', { name: INPUT_BINDING });
      this.bindingRegistered = true;
    }

    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: AUDIO_INPUT_SCRIPT,
    });

    await this.cdp.send('Runtime.evaluate', {
      expression: AUDIO_INPUT_SCRIPT,
      awaitPromise: false,
    });

    this.injected = true;
  }

  /**
   * Play audio bytes into the page's fake microphone.
   * Accepts any format that Web Audio API can decode (WAV, MP3, OGG, etc.).
   *
   * @param audioData - Raw audio file bytes
   * @param options - Playback options
   */
  async play(audioData: ArrayBuffer | Uint8Array, options?: PlayOptions): Promise<void> {
    if (!this.injected) {
      await this.setup();
    }

    const base64 = bufferToBase64(audioData);
    const waitForEnd = options?.waitForEnd ?? true;
    const timeout = options?.timeout ?? 60000;

    if (waitForEnd) {
      const donePromise = this.waitForBinding(timeout);

      await this.cdp.send('Runtime.evaluate', {
        expression: `window.__bpAudioInput.play('${base64}')`,
        awaitPromise: false,
      });

      await donePromise;
    } else {
      await this.cdp.send('Runtime.evaluate', {
        expression: `window.__bpAudioInput.play('${base64}')`,
        awaitPromise: false,
      });
    }
  }

  /**
   * Stop any currently playing audio.
   */
  async stop(): Promise<void> {
    if (!this.injected) return;
    await this.cdp.send('Runtime.evaluate', {
      expression: 'window.__bpAudioInput && window.__bpAudioInput.stop()',
      awaitPromise: false,
    });
  }

  /**
   * Get current state of the injected audio input system.
   */
  async getState(): Promise<AudioInputState> {
    if (!this.injected) {
      return { contextState: 'not-created', isPlaying: false, sampleRate: 0 };
    }
    const result = await this.cdp.send<{ result: { value: AudioInputState } }>('Runtime.evaluate', {
      expression: 'window.__bpAudioInput ? window.__bpAudioInput.getState() : null',
      returnByValue: true,
    });
    return result.result.value ?? { contextState: 'not-created', isPlaying: false, sampleRate: 0 };
  }

  /**
   * Clean up: remove binding handler.
   */
  async teardown(): Promise<void> {
    if (this.bindingHandler) {
      this.cdp.off('Runtime.bindingCalled', this.bindingHandler);
      this.bindingHandler = null;
    }
    await this.stop();
    this.injected = false;
    this.bindingRegistered = false;
  }

  /**
   * Wait for the playback-complete binding to fire.
   */
  private waitForBinding(timeout: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.bindingHandler) {
          this.cdp.off('Runtime.bindingCalled', this.bindingHandler);
          this.bindingHandler = null;
        }
        reject(new Error(`AudioInput: playback timed out after ${timeout}ms`));
      }, timeout);

      if (this.bindingHandler) {
        this.cdp.off('Runtime.bindingCalled', this.bindingHandler);
      }

      this.bindingHandler = (params: Record<string, unknown>) => {
        if (params['name'] === INPUT_BINDING) {
          clearTimeout(timer);
          if (this.bindingHandler) {
            this.cdp.off('Runtime.bindingCalled', this.bindingHandler);
            this.bindingHandler = null;
          }
          resolve();
        }
      };
      this.cdp.on('Runtime.bindingCalled', this.bindingHandler);
    });
  }
}
