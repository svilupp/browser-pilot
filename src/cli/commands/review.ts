import { attachSession, resolveSession } from '../attach.ts';
import { output } from '../output.ts';
import { updateSession } from '../session.ts';

const REVIEW_HELP = `
bp review - Extract structured business state from the current page

When to use:
  You want a structured summary of the page: headings, forms, alerts, tables,
  key-value pairs, and status labels. Useful for verifying business state after
  an action sequence, especially on detail, checkout, and confirmation pages.

When not to use:
  You need the full accessibility tree with refs. Use \`bp snapshot\`.
  You want a compact overview. Use \`bp page\`.
  You are on a dense catalog or marketing page with lots of nav chrome. Use \`bp text\` or \`bp page\`.

Likely next commands:
  bp snapshot -i
  bp exec '[{"action":"click","selector":"ref:e4"}]'

Usage:
  bp review [options]

Global options:
  -s, --session <id>   Session to use (default: most recent)
  --json               Output JSON
  --pretty             Output readable text (default)
  --debug              Enable CDP transport debugging
  -h, --help           Show this help

Examples:
  bp review
  bp review --json
  bp review -s my-session
`.trimEnd();

function formatReviewPretty(review: {
  url: string;
  title: string;
  headings: string[];
  forms: Array<{ label?: string; value: unknown; type: string; disabled: boolean }>;
  alerts: string[];
  tables: Array<{ headers: string[]; rows: string[][] }>;
  keyValues: Array<{ key: string; value: string }>;
  statusLabels: string[];
}): string {
  const lines: string[] = [];

  lines.push(`URL: ${review.url}`);
  lines.push(`Title: ${review.title}`);

  lines.push('', 'Headings:');
  if (review.headings.length === 0) {
    lines.push('  (none)');
  } else {
    for (const h of review.headings) {
      lines.push(`  ${h}`);
    }
  }

  if (review.alerts.length > 0) {
    lines.push('', 'Alerts:');
    for (const a of review.alerts) {
      lines.push(`  ${a}`);
    }
  }

  if (review.statusLabels.length > 0) {
    lines.push('', 'Status:');
    for (const s of review.statusLabels) {
      lines.push(`  ${s}`);
    }
  }

  if (review.keyValues.length > 0) {
    lines.push('', 'Key-Value Pairs:');
    for (const kv of review.keyValues) {
      lines.push(`  ${kv.key}: ${kv.value}`);
    }
  }

  if (review.tables.length > 0) {
    lines.push('', 'Tables:');
    for (const table of review.tables) {
      if (table.headers.length > 0) {
        lines.push(`  | ${table.headers.join(' | ')} |`);
        lines.push(`  | ${table.headers.map(() => '---').join(' | ')} |`);
      }
      for (const row of table.rows) {
        lines.push(`  | ${row.join(' | ')} |`);
      }
      lines.push('');
    }
  }

  lines.push('', 'Forms:');
  if (review.forms.length === 0) {
    lines.push('  (none)');
  } else {
    for (const f of review.forms) {
      const disabled = f.disabled ? ' (disabled)' : '';
      const label = f.label ?? '(unlabeled)';
      lines.push(`  ${label} [${f.type}]: ${f.value ?? ''}${disabled}`);
    }
  }

  return lines.join('\n');
}

export async function reviewCommand(
  _args: string[],
  globalOptions: { session?: string; format?: 'json' | 'pretty'; trace?: boolean; help?: boolean }
): Promise<void> {
  if (globalOptions.help) {
    process.stdout.write(`${REVIEW_HELP}\n`);
    return;
  }

  const session = await resolveSession(globalOptions.session);
  const { browser, page } = await attachSession(session, { trace: globalOptions.trace });

  try {
    const review = await page.review();

    output(
      globalOptions.format === 'json' ? review : formatReviewPretty(review),
      globalOptions.format
    );

    await updateSession(session.id, { currentUrl: review.url });
  } finally {
    await browser.disconnect();
  }
}
