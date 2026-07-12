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
  To turn a manual demo into a replayable browser-pilot workflow:

  1. Start or connect a named session:
       bp connect --name demo

  2. Record the existing session to a named artifact:
       bp record -s demo --profile automation -f ./artifacts/demo.recording.json
       # Perform the flow in the attached browser, then stop with Ctrl+C.

  3. Summarize and inspect the recording:
       bp record summary ./artifacts/demo.recording.json
       bp record inspect ./artifacts/demo.recording.json

  4. Derive replayable JSON steps:
       bp record derive ./artifacts/demo.recording.json -o ./artifacts/demo.workflow.json

  5. Review the derived JSON, then run it:
       jq . ./artifacts/demo.workflow.json
       bp run ./artifacts/demo.workflow.json -s demo

  'bp record' captures an existing session; it does not create a named session.
  'bp record derive' writes JSON steps for 'bp run'. It does not emit Flightplan TOML.
  Translate the derived steps into Flightplan manually when you need a Flightplan flow.

RECORDING (DURING REPLAY)
  Need a screenshot trail while replaying a workflow?

    bp exec --record -s demo -f ./artifacts/demo.workflow.json
    bp exec --record --record-dir ./artifacts/replay -s demo '[{"action":"click","selector":"ref:e2"}]'

  Saves recording.json + screenshots for the latest run.
  The workflow input is not replaced or renamed by --record.
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
