/**
 * Diagnose command - Debug element selection issues
 */

import { type DiagnoseResult, diagnoseElement } from '../../browser/diagnose.ts';
import { attachSession } from '../attach.ts';
import { output } from '../output.ts';
import { getDefaultSession, loadSession, type SessionData, updateSession } from '../session.ts';

const DIAGNOSE_HELP = `
bp diagnose - Debug element selection and find alternatives

When to use:
  A selector or ref failed and you need to understand why.

When not to use:
  You have not inspected the page yet. Start with \`bp snapshot -i\`.

Common mistake:
  Jumping to raw JavaScript before checking browser-pilot's selector diagnostics and suggested alternatives.

Usage:
  bp diagnose <selector>           Diagnose specific selector
  bp diagnose "<fuzzy query>"      Fuzzy search for elements

Examples:
  bp diagnose "#login-btn"         Full diagnostics for element
  bp diagnose "submit"             Find elements matching "submit"
  bp diagnose "ref:e4"             Diagnose by element ref

Local options:
  --max <n>            Max candidates for fuzzy match (default: 5)

Global options:
  -s, --session <id>   Session to use (default: most recent)
  --json               Output JSON
  --pretty             Output readable text (default)
  --debug              Enable CDP transport debugging
  -h, --help           Show this help

Likely next commands:
  bp exec '[{"action":"click","selector":"<suggested-selector>"}]'
  bp snapshot -i
`;

interface DiagnoseOptions {
  maxCandidates?: number;
  help?: boolean;
}

function parseDiagnoseArgs(args: string[]): { selector?: string; options: DiagnoseOptions } {
  const options: DiagnoseOptions = {};
  let selector: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--max') {
      options.maxCandidates = parseInt(args[++i] ?? '5', 10);
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (!arg.startsWith('-')) {
      selector = arg;
    }
  }

  return { selector, options };
}

function formatExactResult(result: DiagnoseResult & { matched: true }): string {
  const lines: string[] = [];

  lines.push(`✓ Element Found: ${result.selector}`);
  lines.push(`  Ref: ${result.ref}`);
  lines.push(`  Role: ${result.element.role}`);
  if (result.element.name) {
    lines.push(`  Name: "${result.element.name}"`);
  }
  lines.push('');

  // Visibility
  lines.push('Visibility:');
  lines.push(`  Visible: ${result.visibility.visible ? '✓ Yes' : '✗ No'}`);
  if (!result.visibility.visible && result.visibility.reasons.length > 0) {
    lines.push(`  Reasons: ${result.visibility.reasons.join(', ')}`);
  }
  lines.push(`  Display: ${result.visibility.display}`);
  lines.push(`  Opacity: ${result.visibility.opacity}`);
  lines.push(`  Size: ${result.visibility.width}x${result.visibility.height}`);
  lines.push(`  In Viewport: ${result.visibility.inViewport ? 'Yes' : 'No'}`);
  lines.push('');

  // Interactivity
  lines.push('Interactivity:');
  lines.push(`  Clickable: ${result.interactivity.clickable ? '✓ Yes' : '✗ No'}`);
  if (!result.interactivity.clickable && result.interactivity.reason) {
    lines.push(`  Reason: ${result.interactivity.reason}`);
  }
  lines.push(`  Disabled: ${result.interactivity.disabled ? 'Yes' : 'No'}`);
  lines.push(`  Readonly: ${result.interactivity.readonly ? 'Yes' : 'No'}`);
  lines.push(`  Covered: ${result.interactivity.covered ? 'Yes' : 'No'}`);
  if (result.interactivity.coveringElement) {
    const ce = result.interactivity.coveringElement;
    lines.push(`  Covering Element: <${ce.tagName}${ce.id ? ` id="${ce.id}"` : ''}>`);
  }
  lines.push('');

  // Suggested selectors
  if (result.suggestedSelectors.length > 0) {
    lines.push('Alternative Selectors:');
    for (const sel of result.suggestedSelectors) {
      lines.push(`  - ${sel}`);
    }
  }

  return lines.join('\n');
}

function formatFuzzyResult(result: DiagnoseResult & { matched: false }): string {
  const lines: string[] = [];

  lines.push(`✗ No exact match for: "${result.query}"`);
  lines.push('');

  if (result.candidates.length === 0) {
    lines.push('No similar elements found.');
    return lines.join('\n');
  }

  lines.push(`Found ${result.candidates.length} similar elements:`);
  lines.push('');

  for (let i = 0; i < result.candidates.length; i++) {
    const c = result.candidates[i]!;
    const score = (c.score * 100).toFixed(0);
    lines.push(`${i + 1}. [${c.ref}] ${c.role} "${c.name || '(no name)'}" (${score}% match)`);
    lines.push(`   Selector: ${c.selector}`);
    lines.push(`   Reason: ${c.matchReason}`);
    if (c.disabled) {
      lines.push(`   ⚠ Disabled`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function diagnoseCommand(
  args: string[],
  globalOptions: { session?: string; format?: 'json' | 'pretty'; trace?: boolean }
): Promise<void> {
  const { selector, options } = parseDiagnoseArgs(args);

  if (options.help || !selector) {
    console.log(DIAGNOSE_HELP);
    return;
  }

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
  const { browser, page } = await attachSession(session, { trace: globalOptions.trace });

  try {
    // Run diagnose
    const result = await diagnoseElement(page, selector, {
      maxCandidates: options.maxCandidates,
    });

    // Update session with current snapshot info
    const snapshot = await page.snapshot();
    await updateSession(session.id, {
      currentUrl: snapshot.url,
      metadata: {
        refCache: {
          url: snapshot.url,
          savedAt: new Date().toISOString(),
          refMap: page.exportRefMap(),
        },
      },
    });

    // Output
    if (globalOptions.format === 'json') {
      output(result, 'json');
    } else {
      if (result.matched) {
        console.log(formatExactResult(result));
      } else {
        console.log(formatFuzzyResult(result));
      }
    }
  } finally {
    await browser.disconnect();
  }
}
