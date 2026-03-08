import { attachSession, resolveSession } from '../attach.ts';
import { output } from '../index.ts';
import { updateSession } from '../session.ts';
import { formatFormFieldsPretty } from './form-utils.ts';

const FORMS_HELP = `
bp forms - List form controls on the current page

Usage:
  bp forms [options]

Options:
  -s, --session <id>   Session to use (default: most recent)
  -f, --format <fmt>   json | pretty (default: pretty)
  --json               Alias for -f json
  --trace              Enable debug tracing
  -h, --help           Show this help

Examples:
  bp forms
  bp forms --json
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
