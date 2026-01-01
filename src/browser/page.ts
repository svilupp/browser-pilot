/**
 * Page class - provides high-level browser automation API
 */

import { BatchExecutor, type BatchOptions, type BatchResult, type Step } from '../actions/index.ts';
import type { CDPClient } from '../cdp/client.ts';
import type { BoxModel, RemoteObject } from '../cdp/protocol.ts';
import {
  waitForAnyElement,
  waitForNetworkIdle as waitForIdle,
  waitForNavigation as waitForNav,
} from '../wait/index.ts';
import {
  type ActionOptions,
  type CustomSelectConfig,
  type Download,
  type ElementInfo,
  ElementNotFoundError,
  type FileInput,
  type FillOptions,
  type NetworkIdleOptions,
  type PageSnapshot,
  type SnapshotNode,
  type SubmitOptions,
  TimeoutError,
  type TypeOptions,
  type WaitForOptions,
} from './types.ts';

const DEFAULT_TIMEOUT = 30000;

export class Page {
  private cdp: CDPClient;
  private rootNodeId: number | null = null;
  private batchExecutor: BatchExecutor;

  constructor(cdp: CDPClient) {
    this.cdp = cdp;
    this.batchExecutor = new BatchExecutor(this);
  }

  /**
   * Initialize the page (enable required CDP domains)
   */
  async init(): Promise<void> {
    await Promise.all([
      this.cdp.send('Page.enable'),
      this.cdp.send('DOM.enable'),
      this.cdp.send('Runtime.enable'),
      this.cdp.send('Network.enable'),
    ]);
  }

  // ============ Navigation ============

  /**
   * Navigate to a URL
   */
  async goto(url: string, options: ActionOptions = {}): Promise<void> {
    const { timeout = DEFAULT_TIMEOUT } = options;

    // Start navigation
    const navPromise = this.waitForNavigation({ timeout });

    await this.cdp.send('Page.navigate', { url });

    const result = await navPromise;
    if (!result) {
      throw new TimeoutError(`Navigation to ${url} timed out after ${timeout}ms`);
    }

    // Refresh root node after navigation
    this.rootNodeId = null;
  }

  /**
   * Get the current URL
   */
  async url(): Promise<string> {
    const result = await this.cdp.send<{ result: RemoteObject }>('Runtime.evaluate', {
      expression: 'location.href',
      returnByValue: true,
    });
    return result.result.value as string;
  }

  /**
   * Get the page title
   */
  async title(): Promise<string> {
    const result = await this.cdp.send<{ result: RemoteObject }>('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });
    return result.result.value as string;
  }

  /**
   * Reload the page
   */
  async reload(options: ActionOptions = {}): Promise<void> {
    const { timeout = DEFAULT_TIMEOUT } = options;

    const navPromise = this.waitForNavigation({ timeout });
    await this.cdp.send('Page.reload');
    await navPromise;

    this.rootNodeId = null;
  }

  /**
   * Go back in history
   */
  async goBack(options: ActionOptions = {}): Promise<void> {
    const { timeout = DEFAULT_TIMEOUT } = options;

    // Get navigation history to find the previous entry
    const history = await this.cdp.send<{
      currentIndex: number;
      entries: Array<{ id: number; url: string }>;
    }>('Page.getNavigationHistory');

    if (history.currentIndex <= 0) {
      // No history to go back to
      return;
    }

    const navPromise = this.waitForNavigation({ timeout });

    // Use CDP navigation instead of history.back() - fires proper events
    await this.cdp.send('Page.navigateToHistoryEntry', {
      entryId: history.entries[history.currentIndex - 1]!.id,
    });

    await navPromise;
    this.rootNodeId = null;
  }

  /**
   * Go forward in history
   */
  async goForward(options: ActionOptions = {}): Promise<void> {
    const { timeout = DEFAULT_TIMEOUT } = options;

    // Get navigation history to find the next entry
    const history = await this.cdp.send<{
      currentIndex: number;
      entries: Array<{ id: number; url: string }>;
    }>('Page.getNavigationHistory');

    if (history.currentIndex >= history.entries.length - 1) {
      // No history to go forward to
      return;
    }

    const navPromise = this.waitForNavigation({ timeout });

    // Use CDP navigation instead of history.forward() - fires proper events
    await this.cdp.send('Page.navigateToHistoryEntry', {
      entryId: history.entries[history.currentIndex + 1]!.id,
    });

    await navPromise;
    this.rootNodeId = null;
  }

  // ============ Core Actions ============

  /**
   * Click an element (supports multi-selector)
   *
   * Uses CDP mouse events for regular elements. For form submit buttons,
   * uses dispatchEvent to reliably trigger form submission in headless Chrome.
   */
  async click(selector: string | string[], options: ActionOptions = {}): Promise<boolean> {
    const element = await this.findElement(selector, options);
    if (!element) {
      if (options.optional) return false;
      throw new ElementNotFoundError(selector);
    }

    await this.scrollIntoView(element.nodeId);

    // Check if this is a form submit button and handle accordingly
    const submitResult = await this.cdp.send<{ result: { value?: { isSubmit?: boolean } } }>(
      'Runtime.evaluate',
      {
        expression: `(() => {
        const el = document.querySelector(${JSON.stringify(element.selector)});
        if (!el) return { isSubmit: false };

        // Check if this is a form submit button
        const isSubmitButton = (el instanceof HTMLButtonElement && (el.type === 'submit' || (el.form && el.type !== 'button'))) ||
                               (el instanceof HTMLInputElement && el.type === 'submit');

        if (isSubmitButton && el.form) {
          // Dispatch submit event directly - works reliably in headless Chrome
          el.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          return { isSubmit: true };
        }
        return { isSubmit: false };
      })()`,
        returnByValue: true,
      }
    );

    const isSubmit = submitResult.result.value?.isSubmit;
    if (!isSubmit) {
      // For non-submit elements, use CDP click only
      // (JS click would cause double-clicking issues with toggle handlers)
      await this.clickElement(element.nodeId);
    }

    return true;
  }

  /**
   * Fill an input field (clears first by default)
   */
  async fill(
    selector: string | string[],
    value: string,
    options: FillOptions = {}
  ): Promise<boolean> {
    const { clear = true } = options;
    const element = await this.findElement(selector, options);

    if (!element) {
      if (options.optional) return false;
      throw new ElementNotFoundError(selector);
    }

    // Focus the element
    await this.cdp.send('DOM.focus', { nodeId: element.nodeId });

    // Clear existing content if requested
    if (clear) {
      await this.cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(element.selector)});
          if (el) {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        })()`,
      });
    }

    // Insert the text
    await this.cdp.send('Input.insertText', { text: value });

    // Dispatch input event
    await this.cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(element.selector)});
        if (el) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()`,
    });

    return true;
  }

  /**
   * Type text character by character (for autocomplete fields, etc.)
   */
  async type(
    selector: string | string[],
    text: string,
    options: TypeOptions = {}
  ): Promise<boolean> {
    const { delay = 50 } = options;
    const element = await this.findElement(selector, options);

    if (!element) {
      if (options.optional) return false;
      throw new ElementNotFoundError(selector);
    }

    await this.cdp.send('DOM.focus', { nodeId: element.nodeId });

    for (const char of text) {
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: char,
        text: char,
      });
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: char,
      });
      if (delay > 0) {
        await sleep(delay);
      }
    }

    return true;
  }

  /**
   * Select option(s) from a native select element
   */
  async select(
    selector: string | string[],
    value: string | string[],
    options?: ActionOptions
  ): Promise<boolean>;
  async select(config: CustomSelectConfig, options?: ActionOptions): Promise<boolean>;
  async select(
    selectorOrConfig: string | string[] | CustomSelectConfig,
    valueOrOptions?: string | string[] | ActionOptions,
    maybeOptions?: ActionOptions
  ): Promise<boolean> {
    // Handle custom select config
    if (
      typeof selectorOrConfig === 'object' &&
      !Array.isArray(selectorOrConfig) &&
      'trigger' in selectorOrConfig
    ) {
      return this.selectCustom(selectorOrConfig, valueOrOptions as ActionOptions);
    }

    const selector = selectorOrConfig as string | string[];
    const value = valueOrOptions as string | string[];
    const options = maybeOptions ?? {};

    const element = await this.findElement(selector, options);
    if (!element) {
      if (options.optional) return false;
      throw new ElementNotFoundError(selector);
    }

    const values = Array.isArray(value) ? value : [value];

    await this.cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(element.selector)});
        if (!el || el.tagName !== 'SELECT') return false;
        const values = ${JSON.stringify(values)};
        for (const opt of el.options) {
          opt.selected = values.includes(opt.value) || values.includes(opt.text);
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
      returnByValue: true,
    });

    return true;
  }

  /**
   * Handle custom (non-native) select/dropdown components
   */
  private async selectCustom(
    config: CustomSelectConfig,
    options: ActionOptions = {}
  ): Promise<boolean> {
    const { trigger, option, value, match = 'text' } = config;

    // Click the trigger to open dropdown
    await this.click(trigger, options);

    // Small delay for dropdown animation
    await sleep(100);

    // Build option selector based on match type
    let optionSelector: string;
    const optionSelectors = Array.isArray(option) ? option : [option];

    if (match === 'contains') {
      optionSelector = optionSelectors.map((s) => `${s}:has-text("${value}")`).join(', ');
    } else if (match === 'value') {
      optionSelector = optionSelectors
        .map((s) => `${s}[data-value="${value}"], ${s}[value="${value}"]`)
        .join(', ');
    } else {
      // match === 'text' - exact text match
      optionSelector = optionSelectors.map((s) => `${s}`).join(', ');
    }

    // Find and click the matching option
    const result = await this.cdp.send<{ result: RemoteObject }>('Runtime.evaluate', {
      expression: `(() => {
        const options = document.querySelectorAll(${JSON.stringify(optionSelector)});
        for (const opt of options) {
          const text = opt.textContent?.trim();
          if (${match === 'text' ? `text === ${JSON.stringify(value)}` : match === 'contains' ? `text?.includes(${JSON.stringify(value)})` : 'true'}) {
            opt.click();
            return true;
          }
        }
        return false;
      })()`,
      returnByValue: true,
    });

    if (!result.result.value) {
      if (options.optional) return false;
      throw new ElementNotFoundError(`Option with ${match} "${value}"`);
    }

    return true;
  }

  /**
   * Check a checkbox or radio button
   */
  async check(selector: string | string[], options: ActionOptions = {}): Promise<boolean> {
    const element = await this.findElement(selector, options);
    if (!element) {
      if (options.optional) return false;
      throw new ElementNotFoundError(selector);
    }

    const result = await this.cdp.send<{ result: RemoteObject }>('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(element.selector)});
        if (!el) return false;
        if (!el.checked) el.click();
        return true;
      })()`,
      returnByValue: true,
    });

    return result.result.value as boolean;
  }

  /**
   * Uncheck a checkbox
   */
  async uncheck(selector: string | string[], options: ActionOptions = {}): Promise<boolean> {
    const element = await this.findElement(selector, options);
    if (!element) {
      if (options.optional) return false;
      throw new ElementNotFoundError(selector);
    }

    const result = await this.cdp.send<{ result: RemoteObject }>('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(element.selector)});
        if (!el) return false;
        if (el.checked) el.click();
        return true;
      })()`,
      returnByValue: true,
    });

    return result.result.value as boolean;
  }

  /**
   * Submit a form (tries Enter key first, then click)
   *
   * Navigation waiting behavior:
   * - 'auto' (default): Attempt to detect navigation for 1 second, then assume client-side handling
   * - true: Wait for full navigation (traditional forms)
   * - false: Return immediately (AJAX forms where you'll wait for something else)
   */
  async submit(selector: string | string[], options: SubmitOptions = {}): Promise<boolean> {
    const { method = 'enter+click', waitForNavigation: shouldWait = 'auto' } = options;
    const element = await this.findElement(selector, options);

    if (!element) {
      if (options.optional) return false;
      throw new ElementNotFoundError(selector);
    }

    // Focus the element
    await this.cdp.send('DOM.focus', { nodeId: element.nodeId });

    // Try Enter first if method includes it
    if (method.includes('enter')) {
      await this.press('Enter');

      if (shouldWait === true) {
        try {
          await this.waitForNavigation({ timeout: options.timeout ?? DEFAULT_TIMEOUT });
          return true;
        } catch {
          // No navigation, try click if method includes it
        }
      } else if (shouldWait === 'auto') {
        // Race: navigation detection vs short delay for client-side handling
        const navigationDetected = await Promise.race([
          this.waitForNavigation({ timeout: 1000, optional: true }).then((success) =>
            success ? 'nav' : null
          ),
          sleep(500).then(() => 'timeout'),
        ]);

        if (navigationDetected === 'nav') {
          return true; // Navigation happened, we're done
        }
        // Short delay passed - assume client-side form, try click if available
      } else {
        // waitForNavigation: false - don't wait
        if (method === 'enter') return true;
      }
    }

    // Try click if method includes it
    if (method.includes('click')) {
      await this.click(element.selector, { ...options, optional: false });

      if (shouldWait === true) {
        await this.waitForNavigation({ timeout: options.timeout ?? DEFAULT_TIMEOUT });
      } else if (shouldWait === 'auto') {
        // Short wait to allow client-side handlers to run
        await sleep(100);
      }
      // waitForNavigation: false - return immediately
    }

    return true;
  }

  /**
   * Press a key
   */
  async press(key: string): Promise<void> {
    // Map common key names
    const keyMap: Record<string, { key: string; code: string; keyCode: number }> = {
      Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
      Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
      Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
      Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
      Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
      ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
      ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
      ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    };

    const keyInfo = keyMap[key] ?? { key, code: key, keyCode: 0 };

    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: keyInfo.key,
      code: keyInfo.code,
      windowsVirtualKeyCode: keyInfo.keyCode,
    });

    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: keyInfo.key,
      code: keyInfo.code,
      windowsVirtualKeyCode: keyInfo.keyCode,
    });
  }

  /**
   * Focus an element
   */
  async focus(selector: string | string[], options: ActionOptions = {}): Promise<boolean> {
    const element = await this.findElement(selector, options);
    if (!element) {
      if (options.optional) return false;
      throw new ElementNotFoundError(selector);
    }

    await this.cdp.send('DOM.focus', { nodeId: element.nodeId });
    return true;
  }

  /**
   * Hover over an element
   */
  async hover(selector: string | string[], options: ActionOptions = {}): Promise<boolean> {
    const element = await this.findElement(selector, options);
    if (!element) {
      if (options.optional) return false;
      throw new ElementNotFoundError(selector);
    }

    await this.scrollIntoView(element.nodeId);
    const box = await this.getBoxModel(element.nodeId);
    if (!box) {
      if (options.optional) return false;
      throw new Error('Could not get element box model');
    }

    const x = box.content[0]! + box.width / 2;
    const y = box.content[1]! + box.height / 2;

    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
    });

    return true;
  }

  /**
   * Scroll an element into view (or scroll to coordinates)
   */
  async scroll(
    selector: string | string[],
    options: ActionOptions & { x?: number; y?: number } = {}
  ): Promise<boolean> {
    const { x, y } = options;

    // If x/y provided, scroll the page
    if (x !== undefined || y !== undefined) {
      await this.cdp.send('Runtime.evaluate', {
        expression: `window.scrollTo(${x ?? 0}, ${y ?? 0})`,
      });
      return true;
    }

    // Otherwise scroll element into view
    const element = await this.findElement(selector, options);
    if (!element) {
      if (options.optional) return false;
      throw new ElementNotFoundError(selector);
    }

    await this.scrollIntoView(element.nodeId);
    return true;
  }

  // ============ Waiting ============

  /**
   * Wait for an element to reach a state
   */
  async waitFor(selector: string | string[], options: WaitForOptions = {}): Promise<boolean> {
    const { timeout = DEFAULT_TIMEOUT, state = 'visible' } = options;
    const selectors = Array.isArray(selector) ? selector : [selector];

    const result = await waitForAnyElement(this.cdp, selectors, { state, timeout });

    if (!result.success && !options.optional) {
      throw new TimeoutError(`Timeout waiting for ${selectors.join(' or ')} to be ${state}`);
    }

    return result.success;
  }

  /**
   * Wait for navigation to complete
   */
  async waitForNavigation(options: ActionOptions = {}): Promise<boolean> {
    const { timeout = DEFAULT_TIMEOUT } = options;
    const result = await waitForNav(this.cdp, { timeout });

    if (!result.success && !options.optional) {
      throw new TimeoutError('Navigation timeout');
    }

    this.rootNodeId = null;
    return result.success;
  }

  /**
   * Wait for network to be idle
   */
  async waitForNetworkIdle(options: NetworkIdleOptions = {}): Promise<boolean> {
    const { timeout = DEFAULT_TIMEOUT, idleTime = 500 } = options;
    const result = await waitForIdle(this.cdp, { timeout, idleTime });

    if (!result.success && !options.optional) {
      throw new TimeoutError('Network idle timeout');
    }

    return result.success;
  }

  // ============ JavaScript Execution ============

  /**
   * Evaluate JavaScript in the page context
   */
  async evaluate<T = unknown, Args extends unknown[] = unknown[]>(
    expression: string | ((...args: Args) => T),
    ...args: Args
  ): Promise<T> {
    let script: string;

    if (typeof expression === 'function') {
      const argString = args.map((a) => JSON.stringify(a)).join(', ');
      script = `(${expression.toString()})(${argString})`;
    } else {
      script = expression;
    }

    const result = await this.cdp.send<{
      result: RemoteObject;
      exceptionDetails?: { text: string };
    }>('Runtime.evaluate', {
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    });

    if (result.exceptionDetails) {
      throw new Error(`Evaluation failed: ${result.exceptionDetails.text}`);
    }

    return result.result.value as T;
  }

  // ============ Screenshots ============

  /**
   * Take a screenshot
   */
  async screenshot(
    options: { format?: 'png' | 'jpeg' | 'webp'; quality?: number; fullPage?: boolean } = {}
  ): Promise<string> {
    const { format = 'png', quality, fullPage = false } = options;

    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;

    if (fullPage) {
      // Get full page dimensions
      const metrics = await this.cdp.send<{
        contentSize: { width: number; height: number };
      }>('Page.getLayoutMetrics');

      clip = {
        x: 0,
        y: 0,
        width: metrics.contentSize.width,
        height: metrics.contentSize.height,
        scale: 1,
      };
    }

    const result = await this.cdp.send<{ data: string }>('Page.captureScreenshot', {
      format,
      quality: format === 'png' ? undefined : quality,
      clip,
      captureBeyondViewport: fullPage,
    });

    return result.data;
  }

  // ============ Text Extraction ============

  /**
   * Get text content from the page or a specific element
   */
  async text(selector?: string): Promise<string> {
    const expression = selector
      ? `document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`
      : 'document.body.innerText';

    const result = await this.cdp.send<{ result: RemoteObject }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
    });

    return (result.result.value as string) ?? '';
  }

  // ============ File Handling ============

  /**
   * Set files on a file input
   */
  async setInputFiles(
    selector: string | string[],
    files: FileInput[],
    options: ActionOptions = {}
  ): Promise<boolean> {
    const element = await this.findElement(selector, options);
    if (!element) {
      if (options.optional) return false;
      throw new ElementNotFoundError(selector);
    }

    // Convert files to the format CDP expects
    const fileData = await Promise.all(
      files.map(async (f) => {
        let base64: string;
        if (typeof f.buffer === 'string') {
          base64 = f.buffer;
        } else {
          const bytes = new Uint8Array(f.buffer);
          base64 = btoa(String.fromCharCode(...bytes));
        }
        return { name: f.name, mimeType: f.mimeType, data: base64 };
      })
    );

    // Use Runtime.evaluate to set files via DataTransfer
    await this.cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const input = document.querySelector(${JSON.stringify(element.selector)});
        if (!input) return false;

        const files = ${JSON.stringify(fileData)};
        const dt = new DataTransfer();

        for (const f of files) {
          const bytes = Uint8Array.from(atob(f.data), c => c.charCodeAt(0));
          const file = new File([bytes], f.name, { type: f.mimeType });
          dt.items.add(file);
        }

        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
      returnByValue: true,
    });

    return true;
  }

  /**
   * Wait for a download to complete, triggered by an action
   */
  async waitForDownload(
    trigger: () => Promise<void>,
    options: ActionOptions = {}
  ): Promise<Download> {
    const { timeout = DEFAULT_TIMEOUT } = options;

    // Enable download events
    await this.cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      eventsEnabled: true,
    });

    return new Promise<Download>((resolve, reject) => {
      let downloadGuid: string | undefined;
      let suggestedFilename: string | undefined;
      let resolved = false;

      const timeoutTimer = setTimeout(() => {
        if (!resolved) {
          cleanup();
          reject(new TimeoutError(`Download timed out after ${timeout}ms`));
        }
      }, timeout);

      const onDownloadWillBegin = (params: Record<string, unknown>) => {
        downloadGuid = params['guid'] as string;
        suggestedFilename = params['suggestedFilename'] as string;
      };

      const onDownloadProgress = (params: Record<string, unknown>) => {
        if (params['guid'] === downloadGuid && params['state'] === 'completed') {
          resolved = true;
          cleanup();

          const download: Download = {
            filename: suggestedFilename ?? 'unknown',
            content: async () => {
              // In a full implementation, we'd read from the download path
              // For now, return empty ArrayBuffer
              return new ArrayBuffer(0);
            },
          };

          resolve(download);
        } else if (params['guid'] === downloadGuid && params['state'] === 'canceled') {
          resolved = true;
          cleanup();
          reject(new Error('Download was canceled'));
        }
      };

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        this.cdp.off('Browser.downloadWillBegin', onDownloadWillBegin);
        this.cdp.off('Browser.downloadProgress', onDownloadProgress);
      };

      this.cdp.on('Browser.downloadWillBegin', onDownloadWillBegin);
      this.cdp.on('Browser.downloadProgress', onDownloadProgress);

      // Execute the trigger action
      trigger().catch((err) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(err);
        }
      });
    });
  }

  // ============ Snapshot ============

  /**
   * Get an accessibility tree snapshot of the page
   */
  async snapshot(): Promise<PageSnapshot> {
    const [url, title, axTree] = await Promise.all([
      this.url(),
      this.title(),
      this.cdp.send<{
        nodes: Array<{
          nodeId: string;
          ignored: boolean;
          role?: { value: string };
          name?: { value: string };
          value?: { value: unknown };
          parentId?: string;
          childIds?: string[];
          backendDOMNodeId?: number;
          properties?: Array<{ name: string; value: { value: unknown } }>;
        }>;
      }>('Accessibility.getFullAXTree'),
    ]);

    // Process accessibility nodes
    const nodes = axTree.nodes.filter((n) => !n.ignored);
    const nodeMap = new Map(nodes.map((n) => [n.nodeId, n]));
    let refCounter = 0;
    const nodeRefs = new Map<string, string>();

    // Assign refs to nodes
    for (const node of nodes) {
      nodeRefs.set(node.nodeId, `e${++refCounter}`);
    }

    // Build tree structure
    const buildNode = (nodeId: string): SnapshotNode | null => {
      const node = nodeMap.get(nodeId);
      if (!node) return null;

      const role = node.role?.value ?? 'generic';
      const name = node.name?.value;
      const value = node.value?.value;
      const ref = nodeRefs.get(nodeId)!;

      const children: SnapshotNode[] = [];
      if (node.childIds) {
        for (const childId of node.childIds) {
          const child = buildNode(childId);
          if (child) children.push(child);
        }
      }

      // Extract properties
      const disabled = node.properties?.find((p) => p.name === 'disabled')?.value.value as
        | boolean
        | undefined;
      const checked = node.properties?.find((p) => p.name === 'checked')?.value.value as
        | boolean
        | undefined;

      return {
        role,
        name: name as string | undefined,
        value: value as string | undefined,
        ref,
        children: children.length > 0 ? children : undefined,
        disabled,
        checked,
      };
    };

    // Find root nodes (nodes without parents that are in the list)
    const rootNodes = nodes.filter((n) => !n.parentId || !nodeMap.has(n.parentId));
    const accessibilityTree = rootNodes
      .map((n) => buildNode(n.nodeId))
      .filter((n): n is SnapshotNode => n !== null);

    // Extract interactive elements
    const interactiveRoles = new Set([
      'button',
      'link',
      'textbox',
      'checkbox',
      'radio',
      'combobox',
      'listbox',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'option',
      'searchbox',
      'slider',
      'spinbutton',
      'switch',
      'tab',
      'treeitem',
    ]);

    const interactiveElements: Array<{
      ref: string;
      role: string;
      name: string;
      selector: string;
      disabled?: boolean;
    }> = [];

    for (const node of nodes) {
      const role = node.role?.value;
      if (role && interactiveRoles.has(role)) {
        const ref = nodeRefs.get(node.nodeId)!;
        const name = (node.name?.value as string) ?? '';
        const disabled = node.properties?.find((p) => p.name === 'disabled')?.value.value as
          | boolean
          | undefined;

        // Generate a selector based on backendDOMNodeId
        // This is a simplified approach - in production you'd want more robust selectors
        const selector = node.backendDOMNodeId
          ? `[data-backend-node-id="${node.backendDOMNodeId}"]`
          : `[aria-label="${name}"]`;

        interactiveElements.push({
          ref,
          role,
          name,
          selector,
          disabled,
        });
      }
    }

    // Generate text representation
    const formatTree = (nodes: SnapshotNode[], depth = 0): string => {
      const lines: string[] = [];
      for (const node of nodes) {
        let line = `${'  '.repeat(depth)}- ${node.role}`;
        if (node.name) line += ` "${node.name}"`;
        line += ` [ref=${node.ref}]`;
        if (node.disabled) line += ' (disabled)';
        if (node.checked !== undefined) line += node.checked ? ' (checked)' : ' (unchecked)';
        lines.push(line);
        if (node.children) {
          lines.push(formatTree(node.children, depth + 1));
        }
      }
      return lines.join('\n');
    };

    const text = formatTree(accessibilityTree);

    return {
      url,
      title,
      timestamp: new Date().toISOString(),
      accessibilityTree,
      interactiveElements,
      text,
    };
  }

  // ============ Batch Execution ============

  /**
   * Execute a batch of steps
   */
  async batch(steps: Step[], options?: BatchOptions): Promise<BatchResult> {
    return this.batchExecutor.execute(steps, options);
  }

  // ============ Lifecycle ============

  /**
   * Reset page state for clean test isolation
   * - Stops any pending operations
   * - Clears localStorage and sessionStorage
   * - Resets internal state
   */
  async reset(): Promise<void> {
    // Reset internal state first
    this.rootNodeId = null;

    // Stop any pending loading
    try {
      await this.cdp.send('Page.stopLoading');
    } catch {
      // Ignore errors
    }

    // Clear storage without navigating (faster and more reliable)
    try {
      await this.cdp.send('Runtime.evaluate', {
        expression: `(() => {
          try { localStorage.clear(); } catch {}
          try { sessionStorage.clear(); } catch {}
        })()`,
      });
    } catch {
      // Ignore if storage clearing fails
    }
  }

  /**
   * Close this page (no-op for now, managed by Browser)
   * This is a placeholder for API compatibility
   */
  async close(): Promise<void> {
    // Page closing is managed by Browser.closePage()
    // This method exists for API convenience in tests
  }

  // ============ Private Helpers ============

  /**
   * Find an element using single or multiple selectors
   */
  private async findElement(
    selectors: string | string[],
    options: { timeout?: number } = {}
  ): Promise<ElementInfo | null> {
    const { timeout = DEFAULT_TIMEOUT } = options;
    const selectorList = Array.isArray(selectors) ? selectors : [selectors];

    const result = await waitForAnyElement(this.cdp, selectorList, {
      state: 'visible',
      timeout,
    });

    if (!result.success || !result.selector) {
      return null;
    }

    // Get the node ID
    await this.ensureRootNode();

    const queryResult = await this.cdp.send<{ nodeId: number }>('DOM.querySelector', {
      nodeId: this.rootNodeId!,
      selector: result.selector,
    });

    if (!queryResult.nodeId) {
      return null;
    }

    // Get backend node ID
    const describeResult = await this.cdp.send<{ node: { backendNodeId: number } }>(
      'DOM.describeNode',
      { nodeId: queryResult.nodeId }
    );

    return {
      nodeId: queryResult.nodeId,
      backendNodeId: describeResult.node.backendNodeId,
      selector: result.selector,
      waitedMs: result.waitedMs,
    };
  }

  /**
   * Ensure we have a valid root node ID
   */
  private async ensureRootNode(): Promise<void> {
    if (this.rootNodeId) return;

    const doc = await this.cdp.send<{ root: { nodeId: number } }>('DOM.getDocument', {
      depth: 0,
    });
    this.rootNodeId = doc.root.nodeId;
  }

  /**
   * Scroll an element into view
   */
  private async scrollIntoView(nodeId: number): Promise<void> {
    await this.cdp.send('DOM.scrollIntoViewIfNeeded', { nodeId });
  }

  /**
   * Get element box model (position and dimensions)
   */
  private async getBoxModel(nodeId: number): Promise<BoxModel | null> {
    try {
      const result = await this.cdp.send<{ model: BoxModel }>('DOM.getBoxModel', {
        nodeId,
      });
      return result.model;
    } catch {
      return null;
    }
  }

  /**
   * Click an element by node ID
   */
  private async clickElement(nodeId: number): Promise<void> {
    const box = await this.getBoxModel(nodeId);
    if (!box) {
      throw new Error('Could not get element box model for click');
    }

    // Calculate center of the element
    const x = box.content[0]! + box.width / 2;
    const y = box.content[1]! + box.height / 2;

    // Perform click
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });

    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
