/**
 * Pure dotenv content parser, split out from `dotenv.ts` so unit tests can
 * import it directly without pulling in the `node:fs` / `process.env`
 * side-effecting loader.
 */

/**
 * Parse dotenv file contents into a plain key/value map.
 *
 * Supports:
 * - `KEY=value` and `export KEY=value`
 * - `#` full-line comments, comments after quoted values, and whitespace-prefixed unquoted comments
 * - blank lines
 * - single-quoted values (literal, no escape processing)
 * - double-quoted values (`\n` and `\"`/`\\` escapes processed)
 * - unquoted values (trimmed, inline `#comment` stripped)
 */
export function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const withoutExport = line.startsWith('export ') ? line.slice('export '.length) : line;

    const eqIndex = withoutExport.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }

    const key = withoutExport.slice(0, eqIndex).trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    const rawValue = withoutExport.slice(eqIndex + 1).trim();
    const quote = rawValue[0];
    let value: string;
    if (quote === '"' || quote === "'") {
      const parsed = parseQuotedValue(rawValue, quote);
      if (parsed === undefined) continue;
      value = parsed;
    } else {
      const commentIndex = findInlineCommentIndex(rawValue);
      value = (commentIndex === -1 ? rawValue : rawValue.slice(0, commentIndex)).trim();
    }

    result[key] = value;
  }

  return result;
}

/** Consume escapes once, then allow only whitespace or a comment after the quote. */
function parseQuotedValue(raw: string, quote: string): string | undefined {
  let value = '';
  for (let i = 1; i < raw.length; i++) {
    const char = raw[i]!;
    if (char === quote) {
      const trailing = raw.slice(i + 1).trim();
      return trailing === '' || trailing.startsWith('#') ? value : undefined;
    }
    if (quote === '"' && char === '\\' && i + 1 < raw.length) {
      const escaped = raw[++i]!;
      switch (escaped) {
        case 'n':
          value += '\n';
          break;
        case 'r':
          value += '\r';
          break;
        case '"':
          value += '"';
          break;
        case '\\':
          value += '\\';
          break;
        default:
          value += `\\${escaped}`;
      }
    } else {
      value += char;
    }
  }
  return undefined;
}

function findInlineCommentIndex(value: string): number {
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '#' && (i === 0 || /\s/.test(value[i - 1]!))) {
      return i;
    }
  }
  return -1;
}
