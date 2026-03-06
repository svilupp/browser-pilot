---
name: creating-browser-automations
description: Record browser workflows and convert them into reliable, fully automated scripts. Use when the user wants to automate a browser workflow, record interactions for replay, convert browser actions to curl commands, or build end-to-end automation recipes that combine browser-pilot steps with API calls.
---

# Creating Browser Automations

Record a workflow once, then produce a self-contained automation recipe: a markdown document with every step needed to replay it — browser-pilot commands, curl equivalents where possible, wait strategies, and multi-selector fallback chains.

> For browser-pilot action reference, see the `automate-browser-actions-and-testing` skill. This skill focuses on the **recording-to-automation pipeline**.

## The Pipeline

```
1. SETUP    — connect + enable listeners
2. RECORD   — capture clicks, inputs, network traffic
3. ANALYZE  — identify API shortcuts, build selector chains
4. GENERATE — produce automation recipe (.md)
5. VALIDATE — replay and fix failures
```

## Phase 1: Setup

Always start a session with **both** recording and network listening enabled. This captures the full picture: what the user clicked AND what API calls those clicks triggered.

```bash
# Start Chrome with debugging (if not already running)
# /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Connect and start recording with full network capture
bp record --listen all --bodies -f recording.json
```

**Key flags:**
- `--listen all` — capture both HTTP and WebSocket traffic alongside clicks
- `--bodies` — capture HTTP response bodies (needed to understand API payloads)
- `-m "*api*"` — filter network to only matching URLs (optional, reduces noise)
- `--max-payload 1024` — increase payload preview length for API analysis

If you need network monitoring in a **separate terminal** (e.g., to watch traffic live while recording):

```bash
# Terminal 1: Record actions
bp record -s mysession -f recording.json

# Terminal 2: Stream network traffic live (pipeable to jq)
bp listen all -s mysession -m "*/api/*" --max-payload 1024
# Or save to file:
bp listen http -s mysession -o traffic.jsonl --bodies
```

## Phase 2: Record the Workflow

Perform the workflow manually in the browser. The recorder captures:

| Captured | Details |
|----------|---------|
| Clicks | Multiple selector strategies per element (role+name, text, aria-label, testid, id, CSS path) |
| Inputs | Final debounced values, passwords redacted |
| Selects | Dropdowns, checkboxes, radio buttons |
| Submits | Form submissions, Enter key |
| Navigations | URL changes with timing |
| HTTP requests | Method, URL, headers, request body, response status, response body |
| WebSocket frames | Sent/received payloads with timestamps |
| Timeline | Unified chronological view merging actions + network |

Press Ctrl+C to stop. Output is a JSON file with `steps[]`, `network{}`, `websockets{}`, and `timeline[]`.

## Phase 3: Analyze the Recording

Read the recording JSON and analyze it to build the automation recipe.

### 3a. Inspect Recorded Steps

```bash
# View the steps (what the user did)
cat recording.json | jq '.steps'

# View with annotations
cat recording.json | jq '.steps[] | {action, selector, annotation}'
```

Each step has multi-selector arrays ordered by reliability:
1. `role=button[name='Submit']` — most stable (accessibility-based)
2. `text=Submit` — reliable for buttons/links
3. `[aria-label="Submit"]` — explicit aria labels
4. `[data-testid="submit-btn"]` — test hooks (very stable if present)
5. `#submit` — ID-based
6. `div.form > button:nth-of-type(1)` — CSS path (fragile, last resort)

### 3b. Identify API Shortcuts

Check the timeline for API calls that happen after each click:

```bash
# Show HTTP POST/PUT requests (likely mutations)
cat recording.json | jq '.network.requests[] | select(.method != "GET") | {method, url, body}'

# Show full request+response pairs
cat recording.json | jq '
  .network as $n |
  $n.requests[] | select(.method != "GET") |
  . as $req |
  {
    method, url, body,
    response: ($n.responses[] | select(.requestId == $req.requestId) | {status, body})
  }
'
```

**Decision: Browser vs API automation**

| Signal | Use Browser (bp exec) | Use API (curl) |
|--------|----------------------|----------------|
| Auth is cookie/session-based | Yes — cookies already in browser | Hard — must replicate auth flow |
| Auth is token-based (Bearer) | Can, but curl is simpler | Yes — extract token, use directly |
| Action triggers complex JS/UI | Yes — need real browser interaction | No — too many side effects |
| Action is a simple REST call | Overkill | Yes — faster, more reliable |
| Response needed for next step | Either — but curl parsing is cleaner | Yes — pipe through jq |
| SPA with client-side routing | Yes — need real navigation events | No — URLs may not map to API |

### 3c. Build curl Commands from Captured Requests

For API calls that can replace browser clicks:

```bash
# Extract curl-ready commands from recording
cat recording.json | jq -r '
  .network.requests[] |
  select(.method != "GET") |
  "curl -X \(.method) \"\(.url)\" \\\n" +
  (if .body then "  -d \x27\(.body)\x27 \\\n" else "" end) +
  "  -H \"Content-Type: application/json\""
'
```

For authenticated requests, capture cookies from the browser:

```bash
# Get cookies from current session
bp eval 'document.cookie'

# Or extract auth headers from recorded requests
cat recording.json | jq '.network.requests[] | select(.headers.Authorization) | .headers.Authorization'
```

## Phase 4: Generate the Automation Recipe

Produce a markdown file documenting the complete automation. Use this template:

````markdown
# Automation: [Workflow Name]

> Generated from recording on [date]. [N] browser steps, [M] API calls.

## Prerequisites
- Chrome running with `--remote-debugging-port=9222`
- Authenticated session (logged in to [service])
- Environment: [any env vars needed]

## Setup
```bash
bp connect --provider generic --name [session-name]
```

## Steps

### Step 1: Navigate to [page]
```bash
bp exec '[{"action":"goto","url":"[url]"}]'
```

### Step 2: [Description from annotation]
```bash
bp exec '[
  {"action":"click","selector":["role=button[name=\u0027More actions\u0027]","text=More actions","[aria-label=\"More actions\"]"]},
  {"action":"wait","timeout":500},
  {"action":"click","selector":["role=menuitem[name=\u0027Duplicate\u0027]","text=Duplicate"]},
  {"action":"wait","waitFor":"navigation"}
]'
```
**Wait:** URL should contain `/draft_orders/`
**Fallback selectors:** [list alternatives if primary fails]

### Step 3: [API shortcut — replaces 3 browser clicks]
```bash
# Instead of clicking through the UI, call the API directly:
curl -X POST "https://api.example.com/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"order_id": "12345", "action": "duplicate"}'
```

## Selector Strategy
| Element | Primary | Fallback 1 | Fallback 2 |
|---------|---------|-----------|-----------|
| [name]  | [role selector] | [text selector] | [CSS selector] |

## Wait Conditions
| After Step | Wait For | Timeout |
|-----------|----------|---------|
| Navigate  | URL contains `/orders/` | 5000ms |
| Click submit | `networkIdle` | 10000ms |

## Error Recovery
- If Step N fails: [what to do]
- Known flaky selectors: [which ones and why]
````

## Phase 5: Validate

Replay the automation and iterate:

```bash
# Replay the recorded steps directly
bp exec -f recording.json --json

# Or replay specific steps from your recipe
bp exec '[
  {"action":"goto","url":"https://example.com"},
  {"action":"click","selector":["role=button[name=\u0027Submit\u0027]","#submit","button[type=submit]"]},
  {"action":"wait","waitFor":"navigation"}
]' --json
```

Check results:
```bash
result=$(bp exec -f recording.json --json)
echo "$result" | jq '.success'
echo "$result" | jq '.steps[] | select(.success == false) | {action, error, hints}'
```

Use failure hints to fix selectors:
```bash
# Hints suggest alternative selectors when one fails
echo "$result" | jq '.steps[] | select(.hints) | .hints[] | select(.confidence == "high")'
```

**Diagnose selector issues:**
```bash
bp diagnose '#my-selector' -s mysession
bp snapshot -i  # Get fresh refs
```

## Power Tips

### Chain Long Sequences
Maximize steps per `bp exec` call — each call has connection overhead:
```bash
# BAD: one call per step
bp exec '{"action":"click","selector":"#btn1"}'
bp exec '{"action":"click","selector":"#btn2"}'

# GOOD: chain everything
bp exec '[
  {"action":"click","selector":"#btn1"},
  {"action":"wait","timeout":300},
  {"action":"click","selector":"#btn2"},
  {"action":"wait","waitFor":"navigation"},
  {"action":"snapshot"}
]'
```

### Multi-Selector Everywhere
Every selector field accepts arrays. Always include 2-3 fallback selectors:
```json
{"action":"click","selector":["role=button[name='Submit']","text=Submit","#submit","button[type=submit]"]}
```

### Optional Steps for Flaky Elements
Cookie banners, popups, tooltips — use `optional: true`:
```json
{"action":"click","selector":"#cookie-accept","optional":true,"timeout":2000}
```

### Wait Minimally But Correctly
- After navigation: `{"action":"wait","waitFor":"navigation"}`
- After AJAX: `{"action":"wait","waitFor":"networkIdle"}`
- For element: `{"action":"wait","selector":".loaded","waitFor":"visible"}`
- Fixed delay (last resort): `{"action":"wait","timeout":500}`

### Extract Data Mid-Automation
```bash
# Get page text
bp eval 'document.querySelector(".order-id").textContent'

# Get structured data
bp eval 'JSON.stringify(Array.from(document.querySelectorAll("tr")).map(r => r.textContent))'

# Save snapshot for comparison
bp snapshot -i
```

### Hybrid: Browser Start, API Continue
Common pattern — authenticate in browser, then switch to API calls:
```bash
# 1. Browser: handle login (complex, has CAPTCHA/2FA)
bp exec '[
  {"action":"goto","url":"https://app.example.com/login"},
  {"action":"fill","selector":"#email","value":"user@example.com","blur":true},
  {"action":"fill","selector":"#password","value":"$PASSWORD","blur":true},
  {"action":"submit","selector":"form"},
  {"action":"wait","waitFor":"navigation"}
]'

# 2. Extract auth token from browser
TOKEN=$(bp eval 'localStorage.getItem("auth_token")' | tr -d '"')

# 3. API: do the actual work (faster, more reliable)
curl -s "https://api.example.com/orders" \
  -H "Authorization: Bearer $TOKEN" | jq '.orders[0].id'
```

### Handle Two-Click Patterns
Menus, dropdowns, confirmation dialogs — always wait between clicks:
```json
[
  {"action":"click","selector":"role=button[name='More actions']"},
  {"action":"wait","timeout":300},
  {"action":"click","selector":"role=menuitem[name='Delete']"},
  {"action":"wait","timeout":200},
  {"action":"click","selector":"role=button[name='Confirm']"}
]
```

### Avoid Fragile Selectors
- **Never** use CSS class selectors on component libraries (Shopify Polaris, MUI, etc.) — classes change between deploys
- **Prefer** `role=` selectors, `[data-testid]`, `[data-cy]`, or `text=` matchers
- **Refs** (`ref:eN`) are session-scoped — great for interactive debugging but not for stored automations
- **Name selectors** like `[name="email"]` are stable for form elements

### Conditional Logic with `bp eval`
```bash
# Check if element exists before acting
EXISTS=$(bp eval 'document.querySelector("#optional-element") !== null')
if [ "$EXISTS" = "true" ]; then
  bp exec '{"action":"click","selector":"#optional-element"}'
fi

# Get count of items
COUNT=$(bp eval 'document.querySelectorAll(".item").length')
echo "Found $COUNT items"
```

## Checklist

Before finalizing an automation recipe:

- [ ] Every click has 2+ selector strategies (role, text, testid, CSS)
- [ ] API shortcuts identified for simple mutations
- [ ] Wait conditions specified after every navigation/AJAX trigger
- [ ] Optional steps used for cookie banners and flaky popups
- [ ] Passwords and secrets use env vars, not hardcoded values
- [ ] Error recovery documented for each failure point
- [ ] Tested end-to-end at least twice
- [ ] `--dialog accept` used where native dialogs may appear
