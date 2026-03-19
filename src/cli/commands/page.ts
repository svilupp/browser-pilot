import type { FormField, InteractiveElement } from '../../browser/types.ts';
import { attachSession, resolveSession } from '../attach.ts';
import { output } from '../index.ts';
import { updateSession } from '../session.ts';
import { formatFormFieldsPretty, formatInteractiveElementsPretty } from './form-utils.ts';

const PAGE_HELP = `
bp page - Show a compact overview of the current page

When to use:
  You want a quick summary of URL, title, headings, forms, and interactive controls.

When not to use:
  You need the full accessibility tree or the full ref inventory for precise automation. Use \`bp snapshot\`.

Common mistake:
  Treating \`bp page\` as exhaustive. It is a compact overview; the Actions section caches reusable refs,
  but use \`bp snapshot -i\` when you need the full actionable surface.

Likely next commands:
  bp snapshot -i
  bp forms
  bp exec '[{"action":"click","selector":"ref:e4"}]'

Usage:
  bp page [options]

Global options:
  -s, --session <id>   Session to use (default: most recent)
  --json               Output JSON
  --pretty             Output readable text (default)
  --debug              Enable CDP transport debugging
  -h, --help           Show this help

Examples:
  bp page
  bp page --json
`.trimEnd();

interface HeadingInfo {
  level: 'h1' | 'h2' | 'h3';
  text: string;
}

interface PageSummary {
  url: string;
  title: string;
  headings: HeadingInfo[];
  forms: FormField[];
  interactiveElements: InteractiveElement[];
}

async function getHeadings(page: {
  evaluate<T>(expression: string): Promise<T>;
}): Promise<HeadingInfo[]> {
  return page.evaluate<HeadingInfo[]>(`(() => {
    return Array.from(document.querySelectorAll('h1, h2, h3'))
      .map((el) => ({
        level: el.tagName.toLowerCase(),
        text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim(),
      }))
      .filter((heading) => heading.text);
  })()`);
}

function formatPageSummary(summary: PageSummary): string {
  const lines = [`URL: ${summary.url}`, `Title: ${summary.title}`];

  lines.push('', 'Headings:');
  if (summary.headings.length === 0) {
    lines.push('  (none)');
  } else {
    for (const heading of summary.headings) {
      lines.push(`  ${heading.level}: ${heading.text}`);
    }
  }

  lines.push('', 'Form fields:');
  if (summary.forms.length === 0) {
    lines.push('  (none)');
  } else {
    lines.push(...formatFormFieldsPretty(summary.forms));
  }

  lines.push('', 'Actions:');
  if (summary.interactiveElements.length === 0) {
    lines.push('  (none)');
  } else {
    lines.push(...formatInteractiveElementsPretty(summary.interactiveElements, 20));
  }

  return lines.join('\n');
}

export async function pageCommand(
  _args: string[],
  globalOptions: { session?: string; format?: 'json' | 'pretty'; trace?: boolean; help?: boolean }
): Promise<void> {
  if (globalOptions.help) {
    process.stdout.write(`${PAGE_HELP}\n`);
    return;
  }

  const session = await resolveSession(globalOptions.session);
  const { browser, page } = await attachSession(session, { trace: globalOptions.trace });

  try {
    const [url, title, headings, forms, snapshot] = await Promise.all([
      page.url(),
      page.title(),
      getHeadings(page),
      page.forms(),
      page.snapshot(),
    ]);

    const summary: PageSummary = {
      url,
      title,
      headings,
      forms,
      interactiveElements: snapshot.interactiveElements,
    };

    output(
      globalOptions.format === 'json' ? summary : formatPageSummary(summary),
      globalOptions.format
    );

    await updateSession(session.id, {
      currentUrl: url,
      metadata: {
        refCache: {
          url,
          savedAt: new Date().toISOString(),
          refMap: page.exportRefMap(),
        },
      },
    });
  } finally {
    await browser.disconnect();
  }
}
