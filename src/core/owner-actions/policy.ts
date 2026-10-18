import type { OwnerActionPolicy, OwnerApproval, PreparedAction } from './types.ts';

/** Bound trusted classifier time; a late result cannot mint an approval. */
export async function evaluateOwnerPolicy(
  policy: OwnerActionPolicy,
  evidence: PreparedAction
): Promise<OwnerApproval> {
  if (!policy.evaluate) return { verdict: 'allow', reason: 'deterministic_policy' };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      policy.evaluate(evidence, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Guard timeout'));
        }, policy.timeoutMs ?? 5000);
      }),
    ]);
    return result &&
      ['allow', 'deny', 'unknown'].includes(result.verdict) &&
      typeof result.reason === 'string'
      ? { verdict: result.verdict, reason: result.reason }
      : { verdict: 'unknown', reason: 'invalid_guard_result' };
  } catch {
    return { verdict: 'unknown', reason: 'guard_unavailable' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export function observeOwnerPolicy(policy: OwnerActionPolicy, verdict: OwnerApproval): void {
  try {
    policy.observe?.(verdict);
  } catch {
    /* Logging cannot change authorization. */
  }
}
