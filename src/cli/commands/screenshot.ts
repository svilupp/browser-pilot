/**
 * Screenshot command - Take a screenshot
 */

import { connect } from '../../index.ts';
import { output } from '../index.ts';
import { getDefaultSession, loadSession, type SessionData } from '../session.ts';

interface ScreenshotOptions {
  outputPath?: string;
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
  fullPage?: boolean;
}

function parseScreenshotArgs(args: string[]): ScreenshotOptions {
  const options: ScreenshotOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--output' || arg === '-o') {
      options.outputPath = args[++i];
    } else if (arg === '--format' || arg === '-f') {
      options.format = args[++i] as ScreenshotOptions['format'];
    } else if (arg === '--quality' || arg === '-q') {
      options.quality = parseInt(args[++i]!, 10);
    } else if (arg === '--full-page' || arg === '--fullpage') {
      options.fullPage = true;
    }
  }

  return options;
}

export async function screenshotCommand(
  args: string[],
  globalOptions: { session?: string; output?: 'json' | 'pretty'; trace?: boolean }
): Promise<void> {
  const options = parseScreenshotArgs(args);

  // Get session
  let session: SessionData | null;
  if (globalOptions.session) {
    session = await loadSession(globalOptions.session);
  } else {
    session = await getDefaultSession();
    if (!session) {
      throw new Error('No session found. Run "bp connect" first.');
    }
  }

  // Connect to browser
  const browser = await connect({
    provider: session.provider,
    wsUrl: session.wsUrl,
    debug: globalOptions.trace,
  });

  try {
    const page = await browser.page();
    const screenshotData = await page.screenshot({
      format: options.format ?? 'png',
      quality: options.quality,
      fullPage: options.fullPage ?? false,
    });

    // If output path specified, write to file
    if (options.outputPath) {
      const buffer = Buffer.from(screenshotData, 'base64');
      await Bun.write(options.outputPath, buffer);
      output(
        {
          success: true,
          path: options.outputPath,
          size: buffer.length,
          format: options.format ?? 'png',
        },
        globalOptions.output
      );
    } else {
      // Output base64 data
      if (globalOptions.output === 'json') {
        output({ data: screenshotData, format: options.format ?? 'png' }, 'json');
      } else {
        console.log(screenshotData);
      }
    }
  } finally {
    await browser.disconnect();
  }
}
