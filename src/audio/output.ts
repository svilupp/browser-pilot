/**
 * AudioOutput — capture audio that a page plays
 *
 * Intercepts audio at multiple levels:
 * 1. AudioContext constructor tracking + per-context ScriptProcessorNode taps
 * 2. AudioNode.connect override to tap connections to AudioDestinationNode
 * 3. HTMLMediaElement.play interception via captureStream
 * 4. RTCPeerConnection override to capture WebRTC audio tracks
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
 *
 * Key design: creates a ScriptProcessorNode tap **inside each AudioContext**
 * that the page creates, so cross-context connections never occur.
 * This handles voice agents that create their own AudioContext (e.g. at 16kHz)
 * and play audio via AudioBufferSourceNode → ctx.destination.
 */
const AUDIO_OUTPUT_SCRIPT = `
(function() {
  // If already installed, stop any active capture but allow re-initialization
  // so that updated scripts (e.g. with new capture strategies) take effect.
  if (window.__bpAudioOutput) {
    if (window.__bpAudioOutput.isCapturing()) window.__bpAudioOutput.stop();
    // Keep existing allAudioContexts if available (preserves pre-override tracking)
  }

  var BUFFER_SIZE = 4096;
  var FLUSH_SAMPLES = 48000; // flush every ~1s at 48kHz (scales with sample rate)
  var capturing = false;
  var capturedChunks = [];
  var totalSamples = 0;
  var flushCount = 0;
  var pendingTracks = [];
  var tappedTrackIds = {};

  // --- Per-context tap infrastructure ---
  // Preserve any AudioContexts tracked by a previous script version
  var allAudioContexts = window.__bpTrackedAudioContexts || [];
  // Use a WeakMap to associate taps with AudioContext instances
  // (native objects like AudioContext may not support custom properties)
  var contextTapMap = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  var contextTapList = []; // fallback: [{ctx, proc}]

  var OrigAudioContext = window.__bpOrigAudioContext || window.AudioContext || window.webkitAudioContext;
  // Save the native connect function once; on re-injection, reuse it to avoid double-wrapping
  var origConnect = window.__bpOrigConnect || AudioNode.prototype.connect;
  window.__bpOrigConnect = origConnect;

  // Our own capture context (48kHz) for WebRTC tracks and media elements
  var captureCtx = null;
  var captureProcessor = null;

  // Save original AudioContext constructor once
  if (!window.__bpOrigAudioContext) {
    window.__bpOrigAudioContext = OrigAudioContext;
  }

  // Override AudioContext constructor to track all instances (skip if already overridden)
  if (OrigAudioContext && !window.__bpAudioContextOverridden) {
    window.__bpAudioContextOverridden = true;
    window.AudioContext = function() {
      var ctx = new (Function.prototype.bind.apply(OrigAudioContext, [null].concat(Array.prototype.slice.call(arguments))))();
      allAudioContexts.push(ctx);
      return ctx;
    };
    window.AudioContext.prototype = OrigAudioContext.prototype;
    Object.keys(OrigAudioContext).forEach(function(k) {
      try { window.AudioContext[k] = OrigAudioContext[k]; } catch(e) {}
    });
    if (window.webkitAudioContext) {
      window.webkitAudioContext = window.AudioContext;
    }
  }

  // Expose tracked contexts on window so re-injections preserve them
  window.__bpTrackedAudioContexts = allAudioContexts;

  // Look up an existing tap for a given AudioContext
  function findTap(ctx) {
    if (contextTapMap) return contextTapMap.get(ctx) || null;
    for (var i = 0; i < contextTapList.length; i++) {
      if (contextTapList[i].ctx === ctx) return contextTapList[i].proc;
    }
    return null;
  }

  // Store a tap for a given AudioContext
  function storeTap(ctx, proc) {
    if (contextTapMap) { contextTapMap.set(ctx, proc); }
    else { contextTapList.push({ ctx: ctx, proc: proc }); }
  }

  // Count stored taps
  function tapCount() {
    if (contextTapMap) {
      var count = 0;
      for (var i = 0; i < allAudioContexts.length; i++) {
        if (contextTapMap.has(allAudioContexts[i])) count++;
      }
      return count;
    }
    return contextTapList.length;
  }

  // Create or retrieve a ScriptProcessorNode tap for a specific AudioContext.
  // The tap lives in the SAME context as the source, avoiding cross-context errors.
  function getOrCreateTap(ctx) {
    var existing = findTap(ctx);
    if (existing) return existing;

    try {
      if (ctx.state === 'closed') return null;
      var channels = Math.min(ctx.destination.channelCount || 2, 2);
      if (channels < 1) channels = 1;
      var proc = ctx.createScriptProcessor(BUFFER_SIZE, channels, channels);
      proc.onaudioprocess = function(e) {
        if (!capturing) return;
        var left = new Float32Array(e.inputBuffer.getChannelData(0));
        var right = e.inputBuffer.numberOfChannels > 1
          ? new Float32Array(e.inputBuffer.getChannelData(1))
          : new Float32Array(left.length);
        capturedChunks.push({ left: left, right: right, sampleRate: ctx.sampleRate });
        totalSamples += left.length;
        if (totalSamples >= FLUSH_SAMPLES) {
          flushToNodeJs();
        }
      };
      // Must connect to destination to keep ScriptProcessorNode alive
      origConnect.call(proc, ctx.destination);
      storeTap(ctx, proc);
      return proc;
    } catch(e) {
      return null;
    }
  }

  // Override AudioNode.prototype.connect to tap connections to any AudioDestinationNode
  AudioNode.prototype.connect = function(destination) {
    var result = origConnect.apply(this, arguments);

    if (capturing && destination instanceof AudioDestinationNode) {
      try {
        var tap = getOrCreateTap(destination.context);
        // Don't connect the tap to itself
        if (tap && tap !== this) {
          origConnect.call(this, tap);
        }
      } catch(e) {}
    }
    return result;
  };

  var origPlay = window.__bpOrigPlay || HTMLMediaElement.prototype.play;
  window.__bpOrigPlay = origPlay;
  HTMLMediaElement.prototype.play = function() {
    if (capturing && !this.__bpCaptured) {
      this.__bpCaptured = true;
      try {
        if (!captureCtx) initCaptureCtx();
        var stream = this.captureStream ? this.captureStream() : null;
        if (stream && captureCtx) {
          var source = captureCtx.createMediaStreamSource(stream);
          origConnect.call(source, captureProcessor);
        }
      } catch(e) {}
    }
    return origPlay.apply(this, arguments);
  };

  // Initialize our own 48kHz capture context for WebRTC and media element tapping
  function initCaptureCtx() {
    captureCtx = new OrigAudioContext({ sampleRate: 48000 });
    captureProcessor = captureCtx.createScriptProcessor(BUFFER_SIZE, 2, 2);
    captureProcessor.onaudioprocess = function(e) {
      if (!capturing) return;
      var left = new Float32Array(e.inputBuffer.getChannelData(0));
      var right = new Float32Array(e.inputBuffer.getChannelData(1));
      capturedChunks.push({ left: left, right: right, sampleRate: 48000 });
      totalSamples += left.length;
      if (totalSamples >= FLUSH_SAMPLES) {
        flushToNodeJs();
      }
    };
    origConnect.call(captureProcessor, captureCtx.destination);
  }

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

  function flushGroup(chunks, rate) {
    var totalLen = 0;
    for (var i = 0; i < chunks.length; i++) {
      totalLen += chunks[i].left.length;
    }
    if (totalLen === 0) return;

    var left = new Float32Array(totalLen);
    var right = new Float32Array(totalLen);
    var offset = 0;
    for (var i = 0; i < chunks.length; i++) {
      left.set(chunks[i].left, offset);
      right.set(chunks[i].right, offset);
      offset += chunks[i].left.length;
    }

    var leftB64 = uint8ToBase64(new Uint8Array(left.buffer));
    var rightB64 = uint8ToBase64(new Uint8Array(right.buffer));

    flushCount++;

    try {
      if (typeof window.__bpAudioOutputData === 'function') {
        window.__bpAudioOutputData(JSON.stringify({
          left: leftB64,
          right: rightB64,
          sampleRate: rate,
          samples: totalLen
        }));
      }
    } catch(e) {}
  }

  function flushToNodeJs() {
    if (capturedChunks.length === 0) return;

    // Group chunks by sample rate to avoid mixing different-rate audio
    var byRate = {};
    for (var i = 0; i < capturedChunks.length; i++) {
      var rate = capturedChunks[i].sampleRate || 48000;
      if (!byRate[rate]) byRate[rate] = [];
      byRate[rate].push(capturedChunks[i]);
    }

    // Flush each sample rate group separately
    for (var rateKey in byRate) {
      if (byRate.hasOwnProperty(rateKey)) {
        flushGroup(byRate[rateKey], Number(rateKey));
      }
    }

    capturedChunks = [];
    totalSamples = 0;
  }

  // --- WebRTC interception (for apps that use RTCPeerConnection) ---
  var rtcTrackedStreams = [];
  var rtcPeerConnections = [];

  function tapAudioTrack(track) {
    try {
      if (tappedTrackIds[track.id]) return;
      tappedTrackIds[track.id] = true;
      if (!captureCtx) initCaptureCtx();
      var stream = new MediaStream([track]);
      var source = captureCtx.createMediaStreamSource(stream);
      origConnect.call(source, captureProcessor);
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

    window.RTCPeerConnection = function() {
      var pc = new (Function.prototype.bind.apply(OrigRTC, [null].concat(Array.prototype.slice.call(arguments))))();
      rtcPeerConnections.push(pc);

      pc.addEventListener('track', function(event) {
        if (event.track && event.track.kind === 'audio') {
          if (capturing) {
            tapAudioTrack(event.track);
          } else {
            pendingTracks.push(event.track);
          }
        }
      });

      return pc;
    };
    window.RTCPeerConnection.prototype = OrigRTC.prototype;
    Object.keys(OrigRTC).forEach(function(k) {
      try { window.RTCPeerConnection[k] = OrigRTC[k]; } catch(e) {}
    });

    window.__bpTrackedPCs = rtcPeerConnections;
  }

  window.__bpAudioOutput = {
    start: function() {
      capturing = true;
      capturedChunks = [];
      totalSamples = 0;
      flushCount = 0;
      tappedTrackIds = {};

      // Resume any suspended capture context
      if (captureCtx && captureCtx.state === 'suspended') captureCtx.resume();

      // Create taps for all tracked AudioContexts (catches contexts created before capture)
      for (var i = 0; i < allAudioContexts.length; i++) {
        var ctx = allAudioContexts[i];
        if (ctx.state !== 'closed') {
          getOrCreateTap(ctx);
        }
      }

      // Drain pending WebRTC tracks
      for (var j = 0; j < pendingTracks.length; j++) {
        tapAudioTrack(pendingTracks[j]);
      }
      pendingTracks = [];

      // Tap existing peer connections
      for (var k = 0; k < rtcPeerConnections.length; k++) {
        tapExistingPeerConnection(rtcPeerConnections[k]);
      }
    },
    stop: function() {
      capturing = false;
      flushToNodeJs();
    },
    isCapturing: function() { return capturing; },
    getBufferedSamples: function() { return totalSamples; },
    tapPC: function(pc) {
      if (!pc || typeof pc.getReceivers !== 'function') return false;
      if (rtcPeerConnections.indexOf(pc) === -1) {
        rtcPeerConnections.push(pc);
      }
      if (capturing) {
        tapExistingPeerConnection(pc);
      }
      pc.addEventListener('track', function(event) {
        if (event.track && event.track.kind === 'audio') {
          if (capturing) {
            tapAudioTrack(event.track);
          } else {
            pendingTracks.push(event.track);
          }
        }
      });
      return true;
    },
    getStats: function() {
      return {
        audioContexts: allAudioContexts.filter(function(c) { return c.state !== 'closed'; }).length,
        contextTaps: tapCount(),
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

    // Retroactively discover existing RTCPeerConnection instances via CDP heap query
    await this.discoverExistingPeerConnections();

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
            `started — ${stats['audioContexts']} AudioContexts, ${stats['contextTaps']} taps, ${stats['rtcConnections']} RTCPeerConnections, ${stats['mediaElements']} MediaElements, ${stats['tappedTracks']} tapped tracks`
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
   *
   * Two-phase approach:
   * 1. **Wait phase**: Wait up to `maxDuration` for the first non-silent chunk.
   *    The silence countdown does NOT tick during this phase, so slow voice agents
   *    (STT → LLM → TTS can take 5-15s) don't cause premature timeout.
   * 2. **Capture phase**: Once audio is detected, capture until `silenceTimeout` ms
   *    of consecutive silence pass, then stop.
   */
  async captureUntilSilence(options?: CaptureOptions): Promise<CaptureResult> {
    const silenceTimeout = options?.silenceTimeout ?? 1500;
    const silenceThreshold = options?.silenceThreshold ?? 0.01;
    const maxDuration = options?.maxDuration ?? 300000;
    const noAudioTimeout = options?.noAudioTimeout ?? 15000;

    if (!this.capturing) {
      await this.start();
    }

    return new Promise<CaptureResult>((resolve) => {
      let heardAudio = false;
      let lastSoundTime = 0;
      const startTime = Date.now();

      const checkInterval = setInterval(async () => {
        const elapsed = Date.now() - startTime;

        // Check max duration (applies to both phases)
        if (elapsed > maxDuration) {
          clearInterval(checkInterval);
          this.onDiagHandler?.(`max duration reached (${maxDuration}ms), stopping`);
          resolve(await this.stop());
          return;
        }

        // Check latest chunk for sound
        const latest = this.chunks[this.chunks.length - 1];
        if (latest) {
          const rms = calculateRMS(latest.left);
          if (rms > silenceThreshold) {
            if (!heardAudio) {
              heardAudio = true;
              this.onDiagHandler?.('first audio detected — silence countdown begins');
            }
            lastSoundTime = Date.now();
          }
        }

        // Early exit if no audio arrives within noAudioTimeout
        if (!heardAudio && elapsed > noAudioTimeout) {
          clearInterval(checkInterval);
          this.onDiagHandler?.(`no audio detected after ${noAudioTimeout}ms, stopping early`);
          resolve(await this.stop());
          return;
        }

        // Only apply silence timeout AFTER first audio detected
        if (heardAudio && Date.now() - lastSoundTime > silenceTimeout) {
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

  /**
   * Use CDP Runtime.queryObjects to find RTCPeerConnection instances
   * that were created before our override was injected, and tap their audio tracks.
   */
  private async discoverExistingPeerConnections(): Promise<void> {
    try {
      const protoResult = await this.cdp.send<{
        result: { objectId?: string };
      }>('Runtime.evaluate', {
        expression: 'typeof RTCPeerConnection !== "undefined" ? RTCPeerConnection.prototype : null',
        returnByValue: false,
      });

      const protoId = protoResult.result.objectId;
      if (!protoId) return;

      const queryResult = await this.cdp.send<{
        objects: { objectId: string };
      }>('Runtime.queryObjects', {
        prototypeObjectId: protoId,
      });

      const arrayId = queryResult.objects.objectId;
      if (!arrayId) return;

      const propsResult = await this.cdp.send<{
        result: Array<{ name: string; value?: { objectId?: string } }>;
      }>('Runtime.getProperties', {
        objectId: arrayId,
        ownProperties: true,
      });

      let tapped = 0;
      for (const prop of propsResult.result) {
        if (prop.name === 'length' || prop.name === '__proto__') continue;
        const pcObjectId = prop.value?.objectId;
        if (!pcObjectId) continue;

        await this.cdp.send('Runtime.callFunctionOn', {
          objectId: pcObjectId,
          functionDeclaration:
            'function() { if (window.__bpAudioOutput && window.__bpAudioOutput.tapPC) { return window.__bpAudioOutput.tapPC(this); } return false; }',
          returnByValue: true,
        });
        tapped++;
      }

      if (tapped > 0) {
        this.onDiagHandler?.(`retroactively discovered ${tapped} existing RTCPeerConnection(s)`);
      }

      await this.cdp.send('Runtime.releaseObject', { objectId: arrayId });
      await this.cdp.send('Runtime.releaseObject', { objectId: protoId });
    } catch {
      // Non-critical — if queryObjects isn't supported or fails, continue without it
    }
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

    // Group chunks by sample rate
    const byRate = new Map<number, AudioChunk[]>();
    for (const chunk of this.chunks) {
      const rate = chunk.sampleRate;
      if (!byRate.has(rate)) byRate.set(rate, []);
      byRate.get(rate)!.push(chunk);
    }

    // Pick the best sample rate group:
    // Prefer the group with the most non-silent audio content
    let bestRate = this.chunks[0]!.sampleRate;
    let bestNonSilentSamples = 0;

    for (const [rate, chunks] of byRate) {
      let nonSilentSamples = 0;
      for (const chunk of chunks) {
        const rms = calculateRMS(chunk.left);
        if (rms > 0.01) {
          nonSilentSamples += chunk.left.length;
        }
      }
      if (nonSilentSamples > bestNonSilentSamples) {
        bestNonSilentSamples = nonSilentSamples;
        bestRate = rate;
      }
    }

    // Merge only chunks from the best rate group
    const bestChunks = byRate.get(bestRate)!;
    let totalLen = 0;
    for (const chunk of bestChunks) {
      totalLen += chunk.left.length;
    }

    const left = new Float32Array(totalLen);
    const right = new Float32Array(totalLen);
    let offset = 0;
    for (const chunk of bestChunks) {
      left.set(chunk.left, offset);
      right.set(chunk.right, offset);
      offset += chunk.left.length;
    }

    if (byRate.size > 1) {
      this.onDiagHandler?.(
        `mergeChunks: ${byRate.size} sample rates detected, using ${bestRate}Hz (${bestNonSilentSamples} non-silent samples)`
      );
    }

    return {
      left,
      right,
      sampleRate: bestRate,
      durationMs: (totalLen / bestRate) * 1000,
      chunkCount: bestChunks.length,
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
