/** Observed capability evidence. An acknowledgement alone must not be recorded as verified. */
export type CapabilityState = 'verified' | 'unsupported' | 'unknown' | 'degraded';
export interface CapabilityEvidence {
  state: CapabilityState;
  probeVersion: string;
  observedAt: string;
  evidence: string;
}
export interface CapabilityReport extends CapabilityEvidence {
  name: string;
  browserGeneration: string;
  revision?: string;
  documentGeneration?: number;
}

/** Lifecycle and document probes have distinct scopes; generation changes invalidate evidence. */
export class CapabilityCache {
  private readonly entries = new Map<string, CapabilityReport>();
  constructor(
    readonly browserGeneration: string,
    readonly revision?: string
  ) {}
  record(name: string, evidence: CapabilityEvidence, documentGeneration?: number): void {
    if (
      !name ||
      !evidence.probeVersion ||
      !evidence.evidence ||
      !Number.isFinite(Date.parse(evidence.observedAt))
    )
      throw new Error('Capability evidence requires name, probe version, time and evidence');
    this.entries.set(name, {
      ...evidence,
      name,
      browserGeneration: this.browserGeneration,
      revision: this.revision,
      documentGeneration,
    });
  }
  get(name: string, documentGeneration?: number): CapabilityReport | undefined {
    const entry = this.entries.get(name);
    if (
      !entry ||
      (entry.documentGeneration !== undefined && entry.documentGeneration !== documentGeneration)
    )
      return undefined;
    return { ...entry };
  }
  report(documentGeneration?: number): CapabilityReport[] {
    return [...this.entries.keys()].flatMap((name) => {
      const entry = this.get(name, documentGeneration);
      return entry ? [entry] : [];
    });
  }
  invalidateDocument(): void {
    for (const [name, entry] of this.entries)
      if (entry.documentGeneration !== undefined) this.entries.delete(name);
  }
}
