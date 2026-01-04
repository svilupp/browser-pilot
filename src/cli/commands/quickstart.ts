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
  bp snapshot --format text

  Output shows the page as an accessibility tree with element refs:
    - heading "Welcome" [ref=e1]
    - button "Sign In" [ref=e2]
    - textbox "Email" [ref=e3]

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
  Use -o json for machine-readable output:
    bp snapshot --format text -o json
    bp exec '{"action":"click","selector":"ref:e3"}' -o json

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

Run 'bp actions' for the complete action reference.
`;

export async function quickstartCommand(): Promise<void> {
  console.log(QUICKSTART);
}
