/** Provider release for native CLI records. Embedding hosts own their own lifecycle. */
import { BrowserBaseProvider } from '../providers/browserbase.ts';
import type { ProviderReleaseResult } from '../providers/types.ts';
import { getEnv } from '../runtime/env.ts';
import type { SessionData } from './session.ts';

/** Call only for the last CLI reference to the provider-owned session. */
export async function releaseBrowserbaseSession(
  session: SessionData
): Promise<ProviderReleaseResult | undefined> {
  if (session.provider !== 'browserbase') return undefined;
  const apiKey = getEnv('BROWSERBASE_API_KEY');
  if (!apiKey || !session.providerSessionId) {
    throw new Error(
      'Browserbase cleanup requires BROWSERBASE_API_KEY and the stored provider session ID. The local session was retained for retry.'
    );
  }
  const projectId = session.metadata?.['projectId'];
  const provider = new BrowserBaseProvider({
    apiKey,
    projectId: typeof projectId === 'string' ? projectId : getEnv('BROWSERBASE_PROJECT_ID'),
  });
  return provider.releaseSession(session.providerSessionId);
}
