import { link, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { type CDPClient, CDPError } from '../../cdp/client.ts';
import { intFlag, parseArgs } from '../../shell/args.ts';
import { createPassiveTraceConnection } from '../../trace/passive-connection.ts';
import { attachSession, resolveSession } from '../attach.ts';
import { output } from '../output.ts';

const HELP = `bp record video - Capture a named session's tab as an MP4

Usage
  bp record video -s <session> -f <file.mp4> [options]

Options
  -s, --session <id>   Record the current tab of this named session
  -f, --file <path>    Write a new .mp4 file
  --label <text>      Show a brief title at the start (up to 100 characters)
  --timeout <ms>      Stop after this time in milliseconds (default 90000)
  --json              Print the file path, byte count, target ID and codec as JSON
  -h, --help          Show this help

Example
  bp record video -s demo -f walkthrough.mp4 --label "Save a filtered view"

Drive the same tab, then press Ctrl+C to save. Flightplan handback also saves
the clip when using a daemon session.

Requires desktop Chrome 153+ with native recording support. Captures actual tab
pixels as silent AV1 video at up to 1280x720 and 30 fps. Use demo data.
`;

async function* readVideo(cdp: CDPClient, handle: string): AsyncGenerator<Buffer> {
  for (;;) {
    const chunk = await cdp.send<{ data: string; base64Encoded?: boolean; eof: boolean }>(
      'IO.read',
      { handle, size: 64 * 1024 }
    );
    if (chunk.data) yield Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
    if (chunk.eof) return;
  }
}

async function saveVideo(cdp: CDPClient, file: string): Promise<number> {
  const dir = await mkdtemp(join(dirname(file), '.bp-video-'));
  try {
    const { stream } = await cdp.send<{ stream: string }>('Page.stopScreenRecording');
    try {
      const temp = join(dir, 'capture.mp4');
      await writeFile(temp, readVideo(cdp, stream), { mode: 0o600 });
      const { size } = await stat(temp);
      if (size === 0)
        throw new Error(
          'Chrome returned an empty recording. Keep the tab open until recording stops.'
        );
      await link(temp, file);
      return size;
    } finally {
      await cdp.send('IO.close', { handle: stream }).catch(() => {});
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function showTitle(cdp: CDPClient, label: string): Promise<void> {
  const result = await cdp.send<{ exceptionDetails?: unknown }>('Runtime.evaluate', {
    expression: `(() => {
      const title = document.createElement('div');
      title.setAttribute('aria-hidden', 'true');
      title.style.cssText = 'all:initial;position:fixed;left:16px;bottom:16px;z-index:2147483647;pointer-events:none;max-width:80vw;padding:8px 14px;border-radius:6px;background:#182131;color:#fff;font:600 18px system-ui;overflow-wrap:anywhere';
      title.textContent = ${JSON.stringify(label)};
      document.documentElement.append(title);
      setTimeout(() => title.remove(), 2400);
    })()`,
  });
  if (result.exceptionDetails) throw new Error('Could not display the video title');
}

/** Record one already-selected tab while the named session remains available for actions. */
export async function recordVideoCommand(
  args: string[],
  global: { session?: string; help?: boolean; format?: 'json' | 'pretty' }
): Promise<void> {
  if (global.help) {
    process.stdout.write(HELP);
    return;
  }
  const { flags, positionals } = parseArgs(args, {
    flags: ['-f', '--file', '--label', '--timeout'],
  });
  if (positionals.length > 0) throw new Error(`Unexpected video argument: ${positionals[0]}`);
  const outputPath = flags.get('--file') ?? flags.get('-f');
  if (!global.session || !outputPath?.toLowerCase().endsWith('.mp4'))
    throw new Error('Usage: bp record video -s <session> -f <file.mp4>');
  const timeout = intFlag(flags.get('--timeout'), 90_000, '--timeout', 1, 2_147_483_647);

  const file = resolve(outputPath);
  const session = await resolveSession(global.session);
  await mkdir(dirname(file), { recursive: true });
  const { browser, page, viaDaemon } = await attachSession(session, {
    policy: 'observe',
    persistBinding: false,
  });
  try {
    const connection = await createPassiveTraceConnection({
      cdp: page.cdpClient,
      targetId: page.targetId,
      session: session.id,
      viaDaemon,
    });
    const { cdp } = connection;
    let stop = () => {};
    const stopped = new Promise<void>((resolveStop) => {
      stop = resolveStop;
    });
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    // Handback can coincide with the final assertion. Give the result time on screen.
    let handbackTimer: ReturnType<typeof setTimeout> | undefined;
    const removeRevocationListener = connection.onRevoked(() => {
      handbackTimer = setTimeout(stop, 1200);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let recording = false;
    let bytes: number | undefined;
    try {
      try {
        await cdp.send('Page.startScreenRecording', {
          frameRate: 30,
          maxWidth: 1280,
          maxHeight: 720,
          audio: false,
        });
        recording = true;
      } catch (error) {
        if (
          error instanceof CDPError &&
          (error.code === -32601 || error.message.includes('without AV1/libaom'))
        ) {
          throw new Error(
            'This browser does not support native tab recording. Try desktop Chrome 153 or newer.'
          );
        }
        throw error;
      }
      const label = flags.get('--label')?.trim().slice(0, 100);
      if (label)
        await showTitle(cdp, label).catch(() => {
          process.stderr.write('Could not display the title. Recording continues.\n');
        });
      await connection.pauseControl();
      process.stderr.write('Recording tab. Press Ctrl+C to save the MP4.\n');
      timer = setTimeout(stop, timeout);
      await stopped;
    } finally {
      clearTimeout(timer);
      clearTimeout(handbackTimer);
      removeRevocationListener();
      try {
        await connection.cleanup(async () => {
          if (recording) bytes = await saveVideo(cdp, file);
        });
      } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      }
    }
    output({ file, bytes, targetId: page.targetId, codec: 'av1' }, global.format);
  } finally {
    await browser.disconnect();
  }
}
