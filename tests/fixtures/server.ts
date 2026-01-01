/**
 * Standalone fixture server for debugging tests
 * Run with: bun tests/fixtures/server.ts
 */

import { join } from 'node:path';

const FIXTURES_DIR = join(import.meta.dir, 'pages');
const DEFAULT_PORT = 3456;

function getContentType(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

export function createFixtureServer(port = DEFAULT_PORT) {
  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      let pathname = url.pathname;

      // Default to index.html for directories
      if (pathname.endsWith('/')) {
        pathname += 'index.html';
      }

      // Handle root - show directory listing
      if (pathname === '/') {
        const pages = [
          '/basic.html',
          '/form.html',
          '/cookie-banner.html',
          '/modal.html',
          '/dropdown.html',
          '/checkboxes.html',
          '/multi-page/page1.html',
        ];

        const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Test Fixtures</title>
  <style>
    body { font-family: sans-serif; padding: 40px; max-width: 600px; margin: 0 auto; }
    h1 { color: #333; }
    ul { list-style: none; padding: 0; }
    li { margin: 10px 0; }
    a { color: #2196F3; text-decoration: none; font-size: 18px; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Test Fixture Pages</h1>
  <ul>
    ${pages.map((p) => `<li><a href="${p}">${p}</a></li>`).join('\n    ')}
  </ul>
</body>
</html>`;
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      const filePath = join(FIXTURES_DIR, pathname);
      const file = Bun.file(filePath);

      if (await file.exists()) {
        const contentType = getContentType(pathname);
        return new Response(file, {
          headers: { 'Content-Type': contentType },
        });
      }

      return new Response('Not Found', { status: 404 });
    },
  });
}

// Run standalone for debugging
if (import.meta.main) {
  const port = parseInt(process.env['PORT'] || String(DEFAULT_PORT), 10);
  const server = createFixtureServer(port);
  console.log(`Fixture server running at http://localhost:${server.port}`);
  console.log('Press Ctrl+C to stop');
}
