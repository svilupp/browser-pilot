# Multi-Selector Guide

Multi-selector is browser-pilot's approach to building robust automations that don't break when websites change.

## The Problem

Traditional browser automation uses single selectors:

```typescript
// Fragile - breaks if ID changes
await page.click('#submit-button-v2');
```

Websites frequently change:
- Element IDs get renamed
- Classes are refactored
- HTML structure changes
- A/B tests show different variants

## The Solution

browser-pilot accepts arrays of selectors. It tries each in order until one works:

```typescript
// Robust - tries multiple selectors
await page.click([
  '#submit-button-v2',      // Try new ID first
  '#submit-button',         // Fall back to old ID
  'button[type=submit]',    // Generic submit button
  '.btn-primary',           // Class-based
]);
```

## How It Works

1. Tries the first selector
2. If element not found or not visible, tries the next
3. Continues until one succeeds or all fail
4. Returns which selector was used (for debugging)

```typescript
const result = await page.batch([
  { action: 'click', selector: ['#new-btn', '#old-btn', '.fallback'] }
]);

console.log(result.steps[0].selectorUsed); // "#old-btn"
```

## Best Practices

### 1. Order by Specificity

Put the most specific (and likely to work) selector first:

```typescript
await page.click([
  '#unique-id',                    // Most specific
  '[data-testid="submit"]',        // Test ID (stable)
  'button[type=submit]',           // Semantic
  '.submit-btn',                   // Class
]);
```

### 2. Mix Selector Types

Use different selector strategies as fallbacks:

```typescript
await page.fill([
  '#email',                        // ID
  '[data-testid="email-input"]',   // Test ID
  'input[type=email]',             // Type attribute
  'input[name=email]',             // Name attribute
  '[placeholder*="email" i]',      // Placeholder (case-insensitive)
], 'user@example.com');
```

### 3. Use Semantic Selectors

Prefer selectors that describe what the element does:

```typescript
// Good - describes function
await page.click([
  'button[aria-label="Submit form"]',
  'button:has-text("Submit")',
  '[role="button"][name="Submit"]',
]);

// Less good - implementation detail
await page.click([
  '.MuiButton-root.css-1abc2de',
]);
```

### 4. Handle Optional Elements

Use `optional: true` for elements that might not exist:

```typescript
// Cookie consent - might not appear
await page.click([
  '#accept-cookies',
  '.cookie-banner .accept',
  'button:has-text("Accept")',
], { optional: true, timeout: 3000 });

// Popup close button
await page.click([
  '.modal-close',
  '[aria-label="Close"]',
  '.popup .close-btn',
], { optional: true });
```

## Common Patterns

### Login Forms

```typescript
await page.batch([
  { action: 'goto', url: 'https://app.example.com/login' },

  // Email field - try multiple patterns
  {
    action: 'fill',
    selector: ['#email', '#username', 'input[type=email]', '[name=email]'],
    value: email
  },

  // Password field
  {
    action: 'fill',
    selector: ['#password', 'input[type=password]', '[name=password]'],
    value: password
  },

  // Remember me (optional)
  {
    action: 'check',
    selector: ['#remember', '.remember-me', '[name=remember]'],
    optional: true
  },

  // Submit button
  {
    action: 'submit',
    selector: ['#login', '#signin', 'button[type=submit]', '.login-btn']
  }
]);
```

### Search Forms

```typescript
await page.batch([
  // Search input
  {
    action: 'fill',
    selector: [
      '#search',
      '[type=search]',
      '[name=q]',
      '[name=query]',
      '[aria-label="Search"]',
      '.search-input'
    ],
    value: searchQuery
  },

  // Submit
  {
    action: 'submit',
    selector: [
      '#search-form',
      'form[action*=search]',
      '.search-form'
    ]
  }
]);
```

### Cookie Consent

```typescript
// Try common cookie consent patterns
await page.click([
  // Common IDs
  '#accept-cookies',
  '#cookie-accept',
  '#gdpr-accept',
  '#consent-accept',

  // Common classes
  '.cookie-accept',
  '.accept-cookies',
  '.gdpr-accept',

  // Text-based
  'button:has-text("Accept")',
  'button:has-text("Accept All")',
  'button:has-text("I Accept")',
  'button:has-text("OK")',

  // ARIA
  '[aria-label="Accept cookies"]',
  '[aria-label="Accept all cookies"]',
], { optional: true, timeout: 5000 });
```

### Navigation Menus

```typescript
// Click a menu item
await page.click([
  'nav a[href="/products"]',
  '#nav-products',
  '.nav-link:has-text("Products")',
  '[data-nav="products"]',
  'header a:has-text("Products")',
]);
```

## Debugging

### See Which Selector Was Used

```typescript
const result = await page.batch([
  { action: 'click', selector: ['#a', '#b', '#c'] }
]);

for (const step of result.steps) {
  console.log(`${step.action}: used ${step.selectorUsed}`);
  if (step.failedSelectors) {
    console.log('  Failed:', step.failedSelectors);
  }
}
```

### Enable Tracing

```typescript
import { enableTracing } from 'browser-pilot';

enableTracing({ output: 'console' });

await page.click(['#a', '#b', '#c']);
// [debug] click: trying #a
// [debug] click: #a not found, trying #b
// [info] click #b ✓ (150ms)
```

## Performance Considerations

- Selectors are tried sequentially, so put likely matches first
- Each selector attempt has its own timeout
- Failed selectors don't count against the main timeout
- The overall timeout applies to finding any match

```typescript
// If #likely exists, this completes fast
// If only .fallback exists, it still works (slightly slower)
await page.click(['#likely', '.fallback'], { timeout: 5000 });
```
