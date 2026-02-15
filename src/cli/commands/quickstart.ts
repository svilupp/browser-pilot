/**
 * Quickstart command - CLI workflow guide for AI agents
 */

const QUICKSTART = `
browser-pilot CLI - Quick Start Guide

STEP 1: CONNECT TO A BROWSER
  bp connect --provider generic --name mysite

  This creates a session. The CLI remembers it for subsequent commands.

STEP 2: NAVIGATE
  bp exec '{"action":"goto","url":"https://example.com"}'

STEP 3: GET PAGE SNAPSHOT
  bp snapshot -i

  Shows only interactive elements (buttons, inputs, links) with refs:
    button "Sign In" [ref=e2]
    textbox "Email" [ref=e3]
    link "Forgot password?" [ref=e6]

  Other formats:
    bp snapshot --format text    # Full accessibility tree (all elements)
    bp snapshot                  # Full snapshot as JSON

STEP 4: INTERACT USING REFS
  bp exec '{"action":"fill","selector":"ref:e3","value":"test@example.com"}'
  bp exec '{"action":"click","selector":"ref:e2"}'

STEP 5: BATCH MULTIPLE ACTIONS
  bp exec '[
    {"action":"fill","selector":"ref:e3","value":"user@test.com"},
    {"action":"click","selector":"ref:e2"},
    {"action":"snapshot"}
  ]'

FOR AI AGENTS
  Use bp snapshot -i for most workflows - shows only actionable elements.
  Add --json for machine-readable output:
    bp snapshot -i --json
    bp exec '{"action":"click","selector":"ref:e3"}' --json

TIPS
  • Refs (e1, e2...) are stable within a page - prefer them over CSS selectors
  • After navigation, take a new snapshot to get updated refs
  • Use multi-selectors for resilience: ["ref:e3", "#email", "input[type=email]"]
  • Add "optional":true to skip elements that may not exist

SELECTOR PRIORITY
  1. ref:e5         From snapshot - most reliable
  2. #id            CSS ID selector
  3. [data-testid]  Test attributes
  4. .class         CSS class (less stable)

COMMON ACTIONS
  goto        {"action":"goto","url":"https://..."}
  click       {"action":"click","selector":"ref:e3"}
  fill        {"action":"fill","selector":"ref:e3","value":"text"}
  submit      {"action":"submit","selector":"form"}
  select      {"action":"select","selector":"ref:e5","value":"option"}
  snapshot    {"action":"snapshot"}
  screenshot  {"action":"screenshot"}

RECORDING (FOR HUMANS)
  Want to create automations by demonstrating instead of coding?
  Use 'bp record' to capture your browser interactions as replayable JSON:

    bp record                 # Record from local Chrome
    bp exec --file login.json # Replay the recording

  Great for creating initial automation scripts that AI agents can refine.

DEBUGGING
  When element selection fails, use these tools to diagnose:

  1. Diagnose a selector:
     bp diagnose '#submit-button' -s mysite

     Shows exact matches, fuzzy matches, visibility issues, and suggestions.

  2. Compare page states:
     bp snapshot > before.json
     # ... perform actions ...
     bp snapshot --diff before.json

     Shows what changed: added/removed/modified elements.

  3. Visual inspection:
     bp snapshot --inspect

     Injects visual ref labels onto the page. Use --keep to leave them visible.

  4. Session logs:
     bp list -s mysite --log-tail 10

     Shows last N commands with timing and any errors.

Run 'bp actions' for the complete action reference.
`;

export async function quickstartCommand(): Promise<void> {
  console.log(QUICKSTART);
}
