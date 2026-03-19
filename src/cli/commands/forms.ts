import { attachSession, resolveSession } from '../attach.ts';
import { output } from '../index.ts';
import { updateSession } from '../session.ts';
import { formatFormFieldsPretty } from './form-utils.ts';

const FORMS_HELP = `
bp forms - List form controls on the current page

When to use:
  You need field names, types, values, or disabled state without the rest of the page.

When not to use:
  You need clickable refs or a broader page summary. Use \`bp snapshot -i\` or \`bp page\`.

Usage:
  bp forms [options]

Global options:
  -s, --session <id>   Session to use (default: most recent)
  --json               Output JSON
  --pretty             Output readable text (default)
  --debug              Enable CDP transport debugging
  -h, --help           Show this help

Examples:
  bp forms
  bp forms --json

Likely next commands:
  bp exec '[{"action":"fill","selector":"ref:e4","value":"..."}]'
  bp review --json
`.trimEnd();

export async function formsCommand(
  _args: string[],
  globalOptions: { session?: string; format?: 'json' | 'pretty'; trace?: boolean; help?: boolean }
): Promise<void> {
  if (globalOptions.help) {
    process.stdout.write(`${FORMS_HELP}\n`);
    return;
  }

  const session = await resolveSession(globalOptions.session);
  const { browser, page } = await attachSession(session, { trace: globalOptions.trace });

  try {
    const [forms, currentUrl] = await Promise.all([page.forms(), page.url()]);

    if (globalOptions.format === 'json') {
      output(forms, 'json');
    } else if (forms.length === 0) {
      process.stdout.write('No form controls found.\n');
    } else {
      process.stdout.write(`${formatFormFieldsPretty(forms).join('\n')}\n`);
    }

    await updateSession(session.id, { currentUrl });
  } finally {
    await browser.disconnect();
  }
}
