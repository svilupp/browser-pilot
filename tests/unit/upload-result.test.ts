import { describe, expect, it, mock } from 'bun:test';
import type { Page } from '../../src/browser/page.ts';
import { uploadFiles } from '../../src/browser/upload.ts';

function createMockPage(
  overrides: {
    waitForResult?: boolean;
    evaluateResults?: unknown[];
    cdpSendResults?: Record<string, unknown>;
    cdpSendFails?: string;
  } = {}
): Page {
  const {
    waitForResult = true,
    evaluateResults = ['file-input', null, false],
    cdpSendResults = {},
    cdpSendFails,
  } = overrides;

  let evalIndex = 0;

  const cdpClient = {
    send: mock(async (method: string) => {
      if (cdpSendFails && method === cdpSendFails) {
        throw new Error(`CDP ${method} failed`);
      }
      if (method === 'DOM.getDocument') {
        return cdpSendResults['DOM.getDocument'] ?? { root: { nodeId: 1 } };
      }
      if (method === 'DOM.querySelector') {
        return cdpSendResults['DOM.querySelector'] ?? { nodeId: 10 };
      }
      if (method === 'DOM.setFileInputFiles') {
        return cdpSendResults['DOM.setFileInputFiles'] ?? {};
      }
      return {};
    }),
  };

  return {
    waitFor: mock(async () => waitForResult),
    evaluate: mock(async () => {
      const result = evaluateResults[evalIndex];
      evalIndex++;
      return result;
    }),
    cdpClient,
  } as unknown as Page;
}

describe('uploadFiles', () => {
  it('uploads files successfully', async () => {
    const page = createMockPage({
      evaluateResults: ['file-input', null, true],
    });

    const result = await uploadFiles(page, {
      selector: '#file-input',
      files: ['/tmp/test.txt', '/tmp/report.pdf'],
    });

    expect(result.accepted).toBe(true);
    expect(result.fileCount).toBe(2);
    expect(result.fileNames).toEqual(['test.txt', 'report.pdf']);
    expect(result.error).toBeUndefined();

    // Verify CDP setFileInputFiles was called
    const sendCalls = (page.cdpClient.send as ReturnType<typeof mock>).mock.calls;
    const setFilesCalls = sendCalls.filter((c: unknown[]) => c[0] === 'DOM.setFileInputFiles');
    expect(setFilesCalls.length).toBe(1);
    expect((setFilesCalls[0] as unknown[])[1]).toEqual({
      files: ['/tmp/test.txt', '/tmp/report.pdf'],
      nodeId: 10,
    });
  });

  it('returns error when file input is not found', async () => {
    const page = createMockPage({
      waitForResult: false,
    });

    const result = await uploadFiles(page, {
      selector: '#nonexistent',
      files: ['/tmp/test.txt'],
    });

    expect(result.accepted).toBe(false);
    expect(result.fileCount).toBe(0);
    expect(result.error).toContain('No file input element found');
  });

  it('returns error when element is not a file input', async () => {
    const page = createMockPage({
      evaluateResults: ['not-file-input'],
    });

    const result = await uploadFiles(page, {
      selector: '#text-input',
      files: ['/tmp/test.txt'],
    });

    expect(result.accepted).toBe(false);
    expect(result.error).toContain('No file input element found');
  });

  it('detects validation errors after upload', async () => {
    const page = createMockPage({
      evaluateResults: ['file-input', 'File too large', false],
    });

    const result = await uploadFiles(page, {
      selector: '#file-input',
      files: ['/tmp/large-file.bin'],
    });

    expect(result.accepted).toBe(true);
    expect(result.validationError).toBe('File too large');
  });

  it('extracts file names from paths correctly', async () => {
    const page = createMockPage({
      evaluateResults: ['file-input', null, false],
    });

    const result = await uploadFiles(page, {
      selector: '#file-input',
      files: ['/home/user/docs/report.pdf', '/tmp/data.csv'],
    });

    expect(result.accepted).toBe(true);
    expect(result.fileNames).toEqual(['report.pdf', 'data.csv']);
  });
});
