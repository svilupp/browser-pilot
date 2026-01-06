/**
 * Recorder class for capturing browser interactions via CDP
 *
 * The Recorder connects to a browser via CDP, injects a recording script,
 * and captures user interactions. Events are aggregated into Step[] for
 * replay via page.batch().
 */

import type { CDPClient } from '../cdp/client.ts';
import { aggregateEvents } from './aggregator.ts';
import { RECORDER_BINDING_NAME, RECORDER_SCRIPT } from './script.ts';
import type { RawRecordedEvent, RecordingOutput } from './types.ts';

/**
 * Recorder captures browser interactions and outputs them as Steps.
 *
 * @example
 * ```typescript
 * const recorder = new Recorder(cdpClient);
 * await recorder.start();
 * // User interacts with the page...
 * const output = await recorder.stop();
 * console.log(output.steps); // Steps for replay
 * ```
 */
export class Recorder {
  private cdp: CDPClient;
  private events: RawRecordedEvent[] = [];
  private recording = false;
  private startTime = 0;
  private startUrl = '';
  private bindingHandler: ((params: Record<string, unknown>) => void) | null = null;

  constructor(cdp: CDPClient) {
    this.cdp = cdp;
  }

  /**
   * Check if recording is currently active.
   */
  get isRecording(): boolean {
    return this.recording;
  }

  /**
   * Start recording browser interactions.
   *
   * Sets up CDP bindings and injects the recorder script into
   * the current page and all future navigations.
   */
  async start(): Promise<void> {
    if (this.recording) {
      throw new Error('Recording already in progress');
    }

    this.events = [];
    this.startTime = Date.now();
    this.recording = true;

    // Enable required CDP domains
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Page.enable');

    // Get current URL for start state
    try {
      const result = await this.cdp.send<{ result: { value: string } }>('Runtime.evaluate', {
        expression: 'location.href',
        returnByValue: true,
      });
      this.startUrl = result.result.value;
    } catch {
      this.startUrl = '';
    }

    // Add binding for recorder callback
    await this.cdp.send('Runtime.addBinding', { name: RECORDER_BINDING_NAME });

    // Auto-inject script on navigation
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: RECORDER_SCRIPT,
    });

    // Inject script into current document
    await this.cdp.send('Runtime.evaluate', {
      expression: RECORDER_SCRIPT,
      awaitPromise: false,
    });

    // Listen for binding calls
    this.bindingHandler = (params: Record<string, unknown>) => {
      if (params['name'] === RECORDER_BINDING_NAME) {
        this.handleBindingCall(params['payload'] as string);
      }
    };
    this.cdp.on('Runtime.bindingCalled', this.bindingHandler);
  }

  /**
   * Stop recording and return aggregated output.
   *
   * Returns a RecordingOutput with steps compatible with page.batch().
   */
  async stop(): Promise<RecordingOutput> {
    if (!this.recording) {
      throw new Error('No recording in progress');
    }

    this.recording = false;
    const duration = Date.now() - this.startTime;

    // Remove event handler
    if (this.bindingHandler) {
      this.cdp.off('Runtime.bindingCalled', this.bindingHandler);
      this.bindingHandler = null;
    }

    // Aggregate events into steps (pass startUrl for navigation detection)
    const steps = aggregateEvents(this.events, this.startUrl);

    return {
      recordedAt: new Date(this.startTime).toISOString(),
      startUrl: this.startUrl,
      duration,
      steps,
    };
  }

  /**
   * Get raw recorded events (for debugging).
   */
  getEvents(): RawRecordedEvent[] {
    return [...this.events];
  }

  /**
   * Handle incoming binding call from the browser.
   */
  private handleBindingCall(payload: string): void {
    if (!this.recording) return;

    try {
      const event = JSON.parse(payload) as RawRecordedEvent;
      this.events.push(event);
    } catch {
      // Invalid payload, ignore
    }
  }
}
