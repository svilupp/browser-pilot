/**
 * AudioOutput — capture audio that a page plays
 *
 * Intercepts audio at multiple levels:
 * 1. AudioContext.destination connections (Web Audio API)
 * 2. HTMLMediaElement.play (audio/video elements via captureStream)
 *
 * Uses ScriptProcessorNode to tap PCM data, transfers to Node.js
 * via Runtime.addBinding.
 */

import type { CDPClient } from '../cdp/client.ts';
import { base64ToBuffer, calculateRMS } from './encoding.ts';
import type { AudioChunk, CaptureOptions, CaptureResult } from './types.ts';

/** Binding name for audio data transfer */
const OUTPUT_BINDING = '__bpAudioOutputData';

/**
 * JS script injected into the page to capture audio output.
 */
const AUDIO_OUTPUT_SCRIPT = `
(function() {
  if (window.__bpAudioOutput) return;

  var BUFFER_SIZE = 4096;
  var FLUSH_SAMPLES = 48000; // flush every ~1 second at 48kHz
  var captureCtx = null;
  var processor = null;
  var capturing = false;
  var capturedChunks = [];
  var totalSamples = 0;
  var pendingTracks = [];
  var tappedTrackIds = {};

  var OrigAudioContext = window.AudioContext || window.webkitAudioContext;
  var origConnect = AudioNode.prototype.connect;

  AudioNode.prototype.connect = function(destination) {
    var result = origConnect.apply(this, arguments);

    // If connecting to a destination node and we're capturing, also tap it
    if (capturing && processor && destination instanceof AudioDestinationNode) {
      try {
        origConnect.call(this, processor);
      } catch(e) {
        // Ignore — may already be connected or incompatible
      }
    }
    return result;
  };

  var origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function() {
    if (capturing && !this.__bpCaptured) {
      this.__bpCaptured = true;
      try {
        if (!captureCtx) initCapture();
        var stream = this.captureStream ? this.captureStream() : null;
        if (stream && captureCtx) {
          var source = captureCtx.createMediaStreamSource(stream);
          origConnect.call(source, processor);
        }
      } catch(e) {
        // captureStream may not be available in all contexts
      }
    }
    return origPlay.apply(this, arguments);
  };

  function initCapture() {
    captureCtx = new OrigAudioContext({ sampleRate: 48000 });
    processor = captureCtx.createScriptProcessor(BUFFER_SIZE, 2, 2);

    processor.onaudioprocess = function(e) {
      if (!capturing) return;
      var left = new Float32Array(e.inputBuffer.getChannelData(0));
      var right = new Float32Array(e.inputBuffer.getChannelData(1));
      capturedChunks.push({ left: left, right: right });
      totalSamples += left.length;

      if (totalSamples >= FLUSH_SAMPLES) {
        flushToNodeJs();
      }
    };

    // Must be connected to destination to keep ScriptProcessorNode running
    origConnect.call(processor, captureCtx.destination);
  }

  function flushToNodeJs() {
    if (capturedChunks.length === 0) return;

    var totalLen = 0;
    for (var i = 0; i < capturedChunks.length; i++) {
      totalLen += capturedChunks[i].left.length;
    }
    var left = new Float32Array(totalLen);
    var right = new Float32Array(totalLen);
    var offset = 0;
    for (var i = 0; i < capturedChunks.length; i++) {
      left.set(capturedChunks[i].left, offset);
      right.set(capturedChunks[i].right, offset);
      offset += capturedChunks[i].left.length;
    }

    var leftBytes = new Uint8Array(left.buffer);
    var rightBytes = new Uint8Array(right.buffer);

    // Use a chunked approach for btoa to avoid call stack limits
    function uint8ToBase64(bytes) {
      var CHUNK = 8192;
      var parts = [];
      for (var i = 0; i < bytes.length; i += CHUNK) {
        var slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
        var binary = '';
        for (var j = 0; j < slice.length; j++) {
          binary += String.fromCharCode(slice[j]);
        }
        parts.push(binary);
      }
      return btoa(parts.join(''));
    }

    var leftB64 = uint8ToBase64(leftBytes);
    var rightB64 = uint8ToBase64(rightBytes);

    try {
      if (typeof window.__bpAudioOutputData === 'function') {
        window.__bpAudioOutputData(JSON.stringify({
          left: leftB64,
          right: rightB64,
          sampleRate: captureCtx.sampleRate,
          samples: totalLen
        }));
      }
    } catch(e) {}

    capturedChunks = [];
    totalSamples = 0;
  }

  // WebRTC interception — capture remote audio tracks
  var rtcTrackedStreams = [];
  var rtcPeerConnections = [];

  function tapAudioTrack(track) {
    try {
      if (tappedTrackIds[track.id]) return;
      tappedTrackIds[track.id] = true;
      if (!captureCtx) initCapture();
      var stream = new MediaStream([track]);
      var source = captureCtx.createMediaStreamSource(stream);
      origConnect.call(source, processor);
      rtcTrackedStreams.push(source);
    } catch(e) {}
  }

  function tapExistingPeerConnection(pc) {
    try {
      var receivers = pc.getReceivers ? pc.getReceivers() : [];
      for (var i = 0; i < receivers.length; i++) {
        if (receivers[i].track && receivers[i].track.kind === 'audio') {
          tapAudioTrack(receivers[i].track);
        }
      }
    } catch(e) {}
  }

  if (typeof RTCPeerConnection !== 'undefined') {
    var OrigRTC = RTCPeerConnection;

    // Override constructor to track all instances
    window.RTCPeerConnection = function() {
      var pc = new (Function.prototype.bind.apply(OrigRTC, [null].concat(Array.prototype.slice.call(arguments))))();
      rtcPeerConnections.push(pc);

      // Listen for new audio tracks
      pc.addEventListener('track', function(event) {
        if (event.track && event.track.kind === 'audio') {
          pendingTracks.push(event.track);
        }
      });

      return pc;
    };
    window.RTCPeerConnection.prototype = OrigRTC.prototype;
    Object.keys(OrigRTC).forEach(function(k) {
      try { window.RTCPeerConnection[k] = OrigRTC[k]; } catch(e) {}
    });

    // Expose tracked PCs for debugging
    window.__bpTrackedPCs = rtcPeerConnections;
  }

  window.__bpAudioOutput = {
    start: function() {
      if (!captureCtx) initCapture();
      if (captureCtx.state === 'suspended') captureCtx.resume();
      capturing = true;
      capturedChunks = [];
      totalSamples = 0;
      tappedTrackIds = {};
      // Drain pending tracks
      for (var i = 0; i < pendingTracks.length; i++) {
        tapAudioTrack(pendingTracks[i]);
      }
      pendingTracks = [];
      // Tap existing peer connections
      for (var j = 0; j < rtcPeerConnections.length; j++) {
        tapExistingPeerConnection(rtcPeerConnections[j]);
      }
    },
    stop: function() {
      capturing = false;
      flushToNodeJs();
    },
    isCapturing: function() { return capturing; },
    getBufferedSamples: function() { return totalSamples; },
    getStats: function() {
      return {
        audioNodes: captureCtx ? captureCtx.destination.numberOfInputs : 0,
        rtcConnections: rtcPeerConnections.length,
        mediaElements: document.querySelectorAll('audio, video').length,
        pendingTracks: pendingTracks.length,
        tappedTracks: Object.keys(tappedTrackIds).length,
        capturing: capturing,
        bufferedSamples: totalSamples
      };
    }
  };
})();
`;

export class AudioOutput {
  private cdp: CDPClient;
  private chunks: AudioChunk[] = [];
  private injected = false;
  private capturing = false;
  private bindingHandler: ((params: Record<string, unknown>) => void) | null = null;
  private onChunkHandler?: (chunk: AudioChunk) => void;
  private onDiagHandler?: (msg: string) => void;
  /** Timestamp of the first non-silent chunk received */
  firstChunkTime: number | null = null;

  constructor(cdp: CDPClient) {
    this.cdp = cdp;
  }

  /** Whether the audio output system has been set up */
  get isSetup(): boolean {
    return this.injected;
  }

  /** Whether audio is currently being captured */
  get isCapturing(): boolean {
    return this.capturing;
  }

  /**
   * Set up audio output capture.
   * Registers bindings and injects the capture script.
   * Must be called before navigating to the page that produces audio.
   */
  async setup(): Promise<void> {
    if (this.injected) return;

    await this.cdp.send('Runtime.addBinding', { name: OUTPUT_BINDING });

    this.bindingHandler = (params: Record<string, unknown>) => {
      if (params['name'] === OUTPUT_BINDING) {
        this.handleAudioData(params['payload'] as string);
      }
    };
    this.cdp.on('Runtime.bindingCalled', this.bindingHandler);

    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: AUDIO_OUTPUT_SCRIPT,
    });

    await this.cdp.send('Runtime.evaluate', {
      expression: AUDIO_OUTPUT_SCRIPT,
      awaitPromise: false,
    });

    this.injected = true;
  }

  /**
   * Start capturing audio output.
   */
  async start(): Promise<void> {
    if (!this.injected) {
      await this.setup();
    }
    this.chunks = [];
    this.firstChunkTime = null;
    this.capturing = true;

    await this.cdp.send('Runtime.evaluate', {
      expression: 'window.__bpAudioOutput && window.__bpAudioOutput.start()',
      awaitPromise: false,
    });

    // Emit diagnostics if handler is attached
    if (this.onDiagHandler) {
      try {
        const statsResult = await this.cdp.send<{ result: { value: Record<string, unknown> } }>(
          'Runtime.evaluate',
          {
            expression: 'window.__bpAudioOutput && window.__bpAudioOutput.getStats()',
            returnByValue: true,
          }
        );
        const stats = statsResult.result.value;
        if (stats) {
          this.onDiagHandler(
            `started — ${stats['audioNodes']} AudioNodes, ${stats['rtcConnections']} RTCPeerConnections, ${stats['mediaElements']} MediaElements, ${stats['tappedTracks']} tapped tracks`
          );
        }
      } catch {}
    }
  }

  /**
   * Stop capturing and return all collected audio.
   */
  async stop(): Promise<CaptureResult> {
    if (!this.injected) {
      return emptyCaptureResult();
    }

    await this.cdp.send('Runtime.evaluate', {
      expression: 'window.__bpAudioOutput && window.__bpAudioOutput.stop()',
      awaitPromise: false,
    });

    this.capturing = false;

    // Small delay to ensure the final flush arrives via binding
    await sleep(250);

    return this.mergeChunks();
  }

  /**
   * Capture audio until silence is detected.
   * Resolves when `silenceTimeout` ms of consecutive silence pass.
   */
  async captureUntilSilence(options?: CaptureOptions): Promise<CaptureResult> {
    const silenceTimeout = options?.silenceTimeout ?? 3000;
    const silenceThreshold = options?.silenceThreshold ?? 0.01;
    const maxDuration = options?.maxDuration ?? 300000;

    await this.start();

    return new Promise<CaptureResult>((resolve) => {
      let lastSoundTime = Date.now();
      const startTime = Date.now();

      const checkInterval = setInterval(async () => {
        // Check max duration
        if (Date.now() - startTime > maxDuration) {
          clearInterval(checkInterval);
          resolve(await this.stop());
          return;
        }

        // Check latest chunk for silence
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
      }, 200);
    });
  }

  /**
   * Subscribe to real-time audio chunks as they arrive.
   */
  onData(handler: (chunk: AudioChunk) => void): void {
    this.onChunkHandler = handler;
  }

  /**
   * Subscribe to diagnostic messages (for --verbose).
   */
  onDiag(handler: (msg: string) => void): void {
    this.onDiagHandler = handler;
  }

  /**
   * Clean up: remove binding handler.
   */
  async teardown(): Promise<void> {
    if (this.capturing) {
      await this.stop();
    }
    if (this.bindingHandler) {
      this.cdp.off('Runtime.bindingCalled', this.bindingHandler);
      this.bindingHandler = null;
    }
    this.onChunkHandler = undefined;
    this.onDiagHandler = undefined;
    this.injected = false;
  }

  private handleAudioData(payload: string): void {
    try {
      const data = JSON.parse(payload) as {
        left: string;
        right: string;
        sampleRate: number;
        samples: number;
      };

      const leftBytes = base64ToBuffer(data.left);
      const rightBytes = base64ToBuffer(data.right);
      const chunk: AudioChunk = {
        left: new Float32Array(leftBytes.buffer),
        right: new Float32Array(rightBytes.buffer),
        sampleRate: data.sampleRate,
        samples: data.samples,
        timestamp: Date.now(),
      };

      this.chunks.push(chunk);

      // Emit chunk diagnostic
      if (this.onDiagHandler) {
        const rms = calculateRMS(chunk.left);
        const label = rms > 0.01 ? 'audio' : 'silence';
        this.onDiagHandler(`chunk: ${chunk.samples} samples, RMS=${rms.toFixed(4)} (${label})`);
      }

      // Track first non-silent chunk
      if (this.firstChunkTime === null) {
        const rms = calculateRMS(chunk.left);
        if (rms > 0.001) {
          this.firstChunkTime = Date.now();
        }
      }

      this.onChunkHandler?.(chunk);
    } catch {
      // Ignore malformed payloads
    }
  }

  private mergeChunks(): CaptureResult {
    if (this.chunks.length === 0) {
      return emptyCaptureResult();
    }

    const sampleRate = this.chunks[0]!.sampleRate;
    let totalLen = 0;
    for (const chunk of this.chunks) {
      totalLen += chunk.left.length;
    }

    const left = new Float32Array(totalLen);
    const right = new Float32Array(totalLen);
    let offset = 0;
    for (const chunk of this.chunks) {
      left.set(chunk.left, offset);
      right.set(chunk.right, offset);
      offset += chunk.left.length;
    }

    return {
      left,
      right,
      sampleRate,
      durationMs: (totalLen / sampleRate) * 1000,
      chunkCount: this.chunks.length,
    };
  }
}

function emptyCaptureResult(): CaptureResult {
  return {
    left: new Float32Array(0),
    right: new Float32Array(0),
    sampleRate: 48000,
    durationMs: 0,
    chunkCount: 0,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
