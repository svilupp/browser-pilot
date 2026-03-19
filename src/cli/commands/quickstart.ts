/**
 * Quickstart command - CLI workflow guide for AI agents
 */

const QUICKSTART = `
browser-pilot CLI - Quick Start Guide

STEP 1: CONNECT TO A BROWSER
  bp connect --name mysite

  This creates a session. The CLI remembers it for subsequent commands.

STEP 2: NAVIGATE
  bp exec -s mysite '{"action":"goto","url":"https://example.com"}'

STEP 3: CHOOSE THE RIGHT INSPECTION COMMAND
  bp snapshot -i

  Shows only interactive elements (buttons, inputs, links) with refs:
    button "Sign In" ref:e2
    textbox "Email" ref:e3
    link "Forgot password?" ref:e6

  Other inspection commands:
    bp page                # Compact overview: URL, title, headings, forms, actions
    bp text                # Readable page copy or policy text
    bp review --json       # Structured business state after actions
    bp diagnose 'submit'   # Debug selector or targeting failures

STEP 4: INTERACT USING REFS
  bp exec -s mysite '{"action":"fill","selector":"ref:e3","value":"test@example.com"}'
  bp exec -s mysite '{"action":"click","selector":"ref:e2"}'

STEP 5: BATCH MULTIPLE ACTIONS
  bp exec -s mysite '[
    {"action":"fill","selector":"ref:e3","value":"user@test.com"},
    {"action":"click","selector":"ref:e2"},
    {"action":"snapshot"}
  ]'

FOR AI AGENTS
  Start with:
    bp --help
    bp --version

  Use bp snapshot -i for most workflows - it shows actionable elements.
  Add --json for machine-readable output:
    bp snapshot -i -s mysite --json
    bp exec -s mysite '{"action":"click","selector":"ref:e3"}' --json

PAGE DISCOVERY SHORTCUTS
  bp page                           # URL, title, headings, forms, and interactive controls
  bp forms                          # Structured list of form fields only
  bp text --selector '#main'        # Focused readable text extraction
  bp review --json                  # Structured business state
  bp targets                        # All available browser tabs
  bp connect --new-tab --page-url https://example.com
                                   # Convenience: start from a fresh tab

TIPS
  - Refs (e1, e2...) are stable within the current page state
  - After navigation or major DOM changes, take a new snapshot to refresh refs
  - Use multi-selectors for resilience: ["ref:e3", "#email", "input[type=email]"]
  - Add "optional":true to skip elements that may not exist
  - Use bp eval only as an escape hatch when higher-level commands are insufficient

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

RECORDING (DURING REPLAY)
  Need a screenshot trail while replaying a workflow?

    bp exec --record --file login.json
    bp exec --record --record-dir ./artifacts/replay '[{"action":"click","selector":"ref:e2"}]'

  Saves recording.json + screenshots for the latest run.
  Sensitive fields (passwords, OTPs, card inputs) are redacted automatically.

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
