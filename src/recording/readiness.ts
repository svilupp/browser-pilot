import type { RecordingManifest } from './manifest.ts';
import { REDACTED_VALUE } from './redaction.ts';

/** Offline evidence can suggest steps, never prove selectors safe or replay starting state restorable. */
export function recordingReadiness(artifact: RecordingManifest) {
  const steps = artifact.recipe.steps;
  return {
    candidate: true,
    safeToReplay: false,
    startingState: {
      restorable: false,
      url: artifact.session.startUrl,
      prerequisites: [
        'Recreate the captured starting UI state, authentication and unsaved values in an explicitly authorized environment.',
        'Verify every locator against the chosen replay document; recording does not prove current uniqueness.',
      ],
    },
    redactedInputs: steps.flatMap((step, index) => (step.value === REDACTED_VALUE ? [index] : [])),
    unresolvedSelectors: steps.flatMap((step, index) =>
      ['click', 'fill', 'select', 'submit', 'press', 'check', 'uncheck'].includes(step.action) &&
      !step.selector
        ? [index]
        : []
    ),
    hazardousActions: steps.flatMap((step, index) =>
      ['click', 'dblclick', 'submit', 'press'].includes(step.action)
        ? [{ stepIndex: index, action: step.action, requiresAuthorization: true }]
        : []
    ),
    screenshotPolicy: artifact.recording?.screenshotPolicy ?? 'unknown',
    captureComplete: artifact.recording?.complete ?? null,
  };
}
