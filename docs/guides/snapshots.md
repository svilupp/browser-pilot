# Snapshots

Snapshots provide an AI-optimized view of the page using the accessibility tree. This is the preferred way for LLMs to understand page content and structure.

## Why Accessibility Tree?

The DOM is verbose and hard for LLMs to parse. The accessibility tree provides:

- **Semantic structure** - roles like button, link, textbox
- **Visible content** - what users actually see
- **Interactive elements** - what can be clicked/typed
- **Compact representation** - 10-100x smaller than raw HTML

## Basic Usage

```typescript
const snapshot = await page.snapshot();

console.log(snapshot.url);              // Current URL
console.log(snapshot.title);            // Page title
console.log(snapshot.text);             // Text representation
console.log(snapshot.accessibilityTree); // Full tree
console.log(snapshot.interactiveElements); // Clickable/typeable elements
```

## Snapshot Structure

```typescript
interface PageSnapshot {
  url: string;
  title: string;
  timestamp: string;
  accessibilityTree: SnapshotNode[];
  interactiveElements: InteractiveElement[];
  text: string;
}

interface SnapshotNode {
  role: string;       // e.g., 'button', 'link', 'textbox'
  name?: string;      // Accessible name
  value?: string;     // Current value (for inputs)
  ref: string;        // Reference ID (e.g., 'e1', 'e2')
  children?: SnapshotNode[];
  disabled?: boolean;
  checked?: boolean;
}

interface InteractiveElement {
  ref: string;        // Reference ID
  role: string;       // Element role
  name: string;       // Accessible name
  selector: string;   // CSS selector
  disabled?: boolean;
}
```

## Text Representation

The `text` property provides a formatted tree ideal for LLMs:

```typescript
const snapshot = await page.snapshot();
console.log(snapshot.text);
```

Output:
```
- banner [ref=e1]
  - link "Home" [ref=e2]
  - link "Products" [ref=e3]
  - link "About" [ref=e4]
- main [ref=e5]
  - heading "Welcome to Our Store" [ref=e6]
  - paragraph "Find the best products..." [ref=e7]
  - searchbox [ref=e8] placeholder="Search products"
  - button "Search" [ref=e9]
- region "Featured Products" [ref=e10]
  - link "Product 1 - $29.99" [ref=e11]
  - link "Product 2 - $49.99" [ref=e12]
  - link "Product 3 - $19.99" [ref=e13]
- contentinfo [ref=e14]
  - link "Contact Us" [ref=e15]
```

## Interactive Elements

Get just the elements that can be interacted with:

```typescript
const snapshot = await page.snapshot();

for (const el of snapshot.interactiveElements) {
  console.log(`[${el.ref}] ${el.role}: ${el.name}`);
}
```

Output:
```
[e2] link: Home
[e3] link: Products
[e4] link: About
[e8] searchbox: (empty)
[e9] button: Search
[e11] link: Product 1 - $29.99
[e12] link: Product 2 - $49.99
[e13] link: Product 3 - $19.99
[e15] link: Contact Us
```

## Using with AI Agents

### Prompt Engineering

Include the snapshot in your LLM prompt:

```typescript
const snapshot = await page.snapshot();

const prompt = `
You are browsing a webpage. Here is the current page state:

URL: ${snapshot.url}
Title: ${snapshot.title}

Page Structure:
${snapshot.text}

Interactive Elements:
${snapshot.interactiveElements.map(e =>
  `- [${e.ref}] ${e.role}: ${e.name}`
).join('\n')}

What action should we take next to accomplish the user's goal?
`;
```

### Reference IDs

Each element has a unique `ref` (e.g., `e1`, `e2`). Use these for targeting:

```typescript
// LLM outputs: "Click on e9 (the Search button)"
const el = snapshot.interactiveElements.find(e => e.ref === 'e9');
await page.click(el.selector);
```

### Compact Format for Token Efficiency

For large pages, extract just what you need:

```typescript
const snapshot = await page.snapshot();

// Just interactive elements
const compact = snapshot.interactiveElements
  .filter(e => !e.disabled)
  .map(e => `${e.ref}:${e.role}:${e.name}`)
  .join('|');

// e2:link:Home|e3:link:Products|e8:searchbox:|e9:button:Search
```

## Filtering the Tree

### Find Specific Roles

```typescript
function findByRole(nodes: SnapshotNode[], role: string): SnapshotNode[] {
  const results: SnapshotNode[] = [];

  function traverse(node: SnapshotNode) {
    if (node.role === role) results.push(node);
    node.children?.forEach(traverse);
  }

  nodes.forEach(traverse);
  return results;
}

const snapshot = await page.snapshot();
const buttons = findByRole(snapshot.accessibilityTree, 'button');
const links = findByRole(snapshot.accessibilityTree, 'link');
```

### Find by Name

```typescript
function findByName(nodes: SnapshotNode[], name: string): SnapshotNode | null {
  for (const node of nodes) {
    if (node.name?.includes(name)) return node;
    if (node.children) {
      const found = findByName(node.children, name);
      if (found) return found;
    }
  }
  return null;
}

const snapshot = await page.snapshot();
const searchButton = findByName(snapshot.accessibilityTree, 'Search');
```

## CLI Usage

```bash
# Text format (default)
bp snapshot -s my-session

# Interactive elements only
bp snapshot -s my-session --format interactive

# Full JSON
bp snapshot -s my-session --format full -o json
```

## Batch Actions

Include snapshots in batch sequences:

```typescript
const result = await page.batch([
  { action: 'goto', url: 'https://example.com' },
  { action: 'fill', selector: '#search', value: 'laptops' },
  { action: 'submit', selector: 'form' },
  { action: 'wait', waitFor: 'networkIdle' },
  { action: 'snapshot' },
]);

const snapshot = result.steps[4].result as PageSnapshot;
```

## Text Extraction

For simpler cases, use `text()` instead of full snapshots:

```typescript
// Full page text
const allText = await page.text();

// Specific element text
const mainContent = await page.text('.main-content');
const articleBody = await page.text('article');
```

## Comparison: snapshot() vs text()

| Method | Returns | Best For |
|--------|---------|----------|
| `snapshot()` | Structured tree + elements | AI agents, complex pages |
| `text()` | Plain text content | Simple extraction, validation |

```typescript
// snapshot() for understanding page structure
const snapshot = await page.snapshot();
// Shows: buttons, links, form fields with their roles and refs

// text() for reading content
const text = await page.text('.article');
// Shows: "Article Title\n\nFirst paragraph..."
```

## Tips for AI Integration

1. **Include the URL and title** for context
2. **Use refs for targeting** - they're stable within a page load (CLI caches refs per session+URL after snapshot)
3. **Filter to interactive elements** for action selection
4. **Include disabled state** to avoid clicking disabled buttons
5. **Use text format** for conversational AI, JSON for tool-based AI
