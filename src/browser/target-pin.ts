/**
 * Target pinning — fingerprint and recover browser targets
 */

import { now } from '../runtime/clock.ts';

export interface TargetFingerprint {
  /** URL at time of pinning */
  url: string;
  /** Page title at time of pinning */
  title: string;
  /** Original target ID */
  originalTargetId: string;
  /** Timestamp when pinned */
  pinnedAt: number;
}

export interface PinRecoveryResult {
  /** Recovered target ID */
  targetId: string;
  /** How recovery was achieved */
  method: 'exact' | 'url_match' | 'title_match' | 'best_guess';
  /** Confidence 0-1 */
  confidence: number;
}

export interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
  attached: boolean;
}

/**
 * Create a fingerprint for the current target
 */
export function createTargetFingerprint(
  targetId: string,
  url: string,
  title: string
): TargetFingerprint {
  return {
    url,
    title,
    originalTargetId: targetId,
    pinnedAt: now(),
  };
}

/**
 * Score a target candidate against a fingerprint
 */
function scoreCandidate(candidate: TargetInfo, pin: TargetFingerprint): number {
  // Exact target ID match
  if (candidate.targetId === pin.originalTargetId) return 1.0;

  let score = 0;

  // URL match (strongest signal after exact ID)
  if (candidate.url && pin.url) {
    if (candidate.url === pin.url) {
      score += 0.6;
    } else {
      // Same origin match
      try {
        const candidateOrigin = new URL(candidate.url).origin;
        const pinOrigin = new URL(pin.url).origin;
        if (candidateOrigin === pinOrigin) score += 0.3;
      } catch {
        // Invalid URLs, skip
      }
    }
  }

  // Title match
  if (candidate.title && pin.title) {
    if (candidate.title === pin.title) {
      score += 0.3;
    } else if (candidate.title.includes(pin.title) || pin.title.includes(candidate.title)) {
      score += 0.15;
    }
  }

  // Penalize non-page types
  if (candidate.type !== 'page') score *= 0.5;

  return Math.min(score, 0.95); // Cap below 1.0 (reserved for exact ID)
}

/**
 * Recover a pinned target from available targets.
 * Returns null if no suitable candidate found.
 */
export function recoverPinnedTarget(
  pin: TargetFingerprint,
  targets: TargetInfo[],
  threshold: number = 0.4
): PinRecoveryResult | null {
  if (targets.length === 0) return null;

  let bestTarget: TargetInfo | null = null;
  let bestScore = 0;

  for (const target of targets) {
    const score = scoreCandidate(target, pin);
    if (score > bestScore) {
      bestScore = score;
      bestTarget = target;
    }
  }

  if (!bestTarget || bestScore < threshold) return null;

  let method: PinRecoveryResult['method'];
  if (bestTarget.targetId === pin.originalTargetId) {
    method = 'exact';
  } else if (bestTarget.url === pin.url) {
    method = 'url_match';
  } else if (bestTarget.title === pin.title) {
    method = 'title_match';
  } else {
    method = 'best_guess';
  }

  return {
    targetId: bestTarget.targetId,
    method,
    confidence: bestScore,
  };
}
