/**
 * File upload helper — wraps CDP setInputFiles with verification
 */

import type { Page } from './page.ts';

export interface UploadConfig {
  /** File input selector */
  selector: string | string[];
  /** File paths to upload */
  files: string[];
  /** Timeout */
  timeout?: number;
}

export interface UploadResult {
  /** Whether files were accepted by the input */
  accepted: boolean;
  /** Number of files set */
  fileCount: number;
  /** File names */
  fileNames: string[];
  /** Whether files appear in visible UI (best-effort check) */
  visibleInUI?: boolean;
  /** Validation error text if any */
  validationError?: string;
  /** Error if upload failed */
  error?: string;
}

/**
 * Upload files to a file input and verify acceptance.
 */
export async function uploadFiles(page: Page, config: UploadConfig): Promise<UploadResult> {
  const { selector, files, timeout = 10000 } = config;

  const fileNames = files.map((f) => f.split('/').pop() ?? f);

  try {
    // Find the file input element
    const selectors = Array.isArray(selector) ? selector : [selector];
    let nodeId: number | undefined;

    for (const sel of selectors) {
      try {
        const found = await page.waitFor(sel, {
          timeout: Math.min(timeout, 5000),
          optional: true,
          state: 'attached',
        });
        if (found) {
          // Check if element is a file input
          const result = await page.evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(sel)});
            if (!el) return null;
            return el.tagName.toLowerCase() === 'input' && el.type === 'file' ? 'file-input' : 'not-file-input';
          })()`);

          if (result === 'file-input') {
            // Use DOM.querySelector to get nodeId
            const doc = await page.cdpClient.send<{ root: { nodeId: number } }>('DOM.getDocument');
            const queryResult = await page.cdpClient.send<{ nodeId: number }>('DOM.querySelector', {
              nodeId: doc.root.nodeId,
              selector: sel,
            });
            nodeId = queryResult.nodeId;
            break;
          }
        }
      } catch {}
    }

    if (!nodeId) {
      return {
        accepted: false,
        fileCount: 0,
        fileNames,
        error: 'No file input element found',
      };
    }

    // Set files via CDP
    await page.cdpClient.send('DOM.setFileInputFiles', {
      files,
      nodeId,
    });

    // Brief wait for UI update
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Check for validation errors (best-effort)
    let validationError: string | undefined;
    try {
      const errorText = await page.evaluate(`(() => {
        const errorSelectors = ['.error', '.validation-error', '[class*="error"]', '[role="alert"]'];
        for (const sel of errorSelectors) {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null && el.textContent.trim()) {
            return el.textContent.trim();
          }
        }
        return null;
      })()`);
      if (errorText) validationError = String(errorText);
    } catch {
      // Best-effort
    }

    // Check if file names appear in visible UI
    let visibleInUI: boolean | undefined;
    try {
      const visible = await page.evaluate(`(() => {
        const text = document.body.innerText;
        const fileNames = ${JSON.stringify(fileNames)};
        return fileNames.some(name => text.includes(name));
      })()`);
      visibleInUI = visible === true;
    } catch {
      // Best-effort
    }

    return {
      accepted: true,
      fileCount: files.length,
      fileNames,
      visibleInUI,
      validationError,
    };
  } catch (error) {
    return {
      accepted: false,
      fileCount: 0,
      fileNames,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
