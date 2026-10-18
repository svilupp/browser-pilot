import { readFileSync } from 'node:fs';
import { decodeObject, jsonString, optionalJson, parseJson } from '../utils/json.ts';

declare const __BP_CLI_VERSION__: string | undefined;

let cachedCliVersion: string | undefined;

function readVersionFromPackageJson(): string | undefined {
  const candidates = ['../package.json', '../../package.json', '../../../package.json'];

  for (const relativePath of candidates) {
    try {
      const fileUrl = new URL(relativePath, import.meta.url);
      const parsed = decodeObject(parseJson(readFileSync(fileUrl, 'utf8')), {
        name: optionalJson(jsonString),
        version: optionalJson(jsonString),
      });

      if (parsed.name === 'browser-pilot' && parsed.version) {
        return parsed.version;
      }
    } catch {
      // Try the next candidate. Source and bundled layouts differ.
    }
  }

  return undefined;
}

export function getCliVersion(): string {
  if (cachedCliVersion) {
    return cachedCliVersion;
  }

  cachedCliVersion =
    (typeof __BP_CLI_VERSION__ === 'string' && __BP_CLI_VERSION__) ||
    readVersionFromPackageJson() ||
    '0.0.0';

  return cachedCliVersion;
}
