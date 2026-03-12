/**
 * Audio permission handling via CDP
 *
 * Grants microphone permissions both at the browser level (CDP)
 * and as a JS safety net (for sites that pre-check permissions.query).
 */

import type { CDPClient } from '../cdp/client.ts';

/**
 * Grant microphone permissions for a page.
 *
 * Uses two layers:
 * 1. CDP Browser.grantPermissions — the primary mechanism
 * 2. JS navigator.permissions.query override — safety net for sites
 *    that check permission state before calling getUserMedia
 */
export async function grantAudioPermissions(cdp: CDPClient, origin?: string): Promise<void> {
  await cdp.send('Browser.grantPermissions', {
    permissions: ['audioCapture'],
    origin: origin ?? '',
  });

  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: PERMISSIONS_OVERRIDE_SCRIPT,
  });
  await cdp.send('Runtime.evaluate', {
    expression: PERMISSIONS_OVERRIDE_SCRIPT,
    awaitPromise: false,
  });
}

const PERMISSIONS_OVERRIDE_SCRIPT = `
(function() {
  if (window.__bpPermissionsPatched) return;
  window.__bpPermissionsPatched = true;

  var origQuery = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = function(desc) {
    if (desc && (desc.name === 'microphone' || desc.name === 'audio-capture')) {
      return Promise.resolve({
        state: 'granted',
        onchange: null,
        addEventListener: function() {},
        removeEventListener: function() {},
        dispatchEvent: function() { return true; }
      });
    }
    return origQuery(desc);
  };
})();
`;
