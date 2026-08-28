/** Shared CLI output formatting without importing the command dispatcher. */

export function output(data: unknown, format: 'json' | 'pretty' = 'pretty'): void {
  const text = renderOutput(data, format);
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

export function renderOutput(data: unknown, format: 'json' | 'pretty' = 'pretty'): string {
  if (format === 'json') {
    return JSON.stringify(data, null, 2);
  }

  if (typeof data === 'string') {
    return data;
  }

  if (Array.isArray(data)) {
    return JSON.stringify(data, null, 2);
  }

  if (typeof data === 'object' && data !== null) {
    const lines: string[] = [];
    const { truncated } = prettyPrint(data as Record<string, unknown>, lines);
    if (truncated) {
      lines.push('', '(Output truncated. Use --json for full data)');
    }
    return lines.join('\n');
  }

  return String(data);
}

function prettyPrint(
  obj: Record<string, unknown>,
  lines: string[],
  indent = 0
): { truncated: boolean } {
  const prefix = '  '.repeat(indent);
  let truncated = false;

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      lines.push(`${prefix}${key}:`);
      const result = prettyPrint(value as Record<string, unknown>, lines, indent + 1);
      if (result.truncated) truncated = true;
    } else if (Array.isArray(value)) {
      lines.push(`${prefix}${key}: [${value.length} items]`);
      truncated = true;
    } else {
      lines.push(`${prefix}${key}: ${value}`);
    }
  }

  return { truncated };
}
