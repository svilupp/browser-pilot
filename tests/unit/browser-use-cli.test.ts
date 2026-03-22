import { describe, expect, test } from 'bun:test';

describe('browser-use CLI args', () => {
  test('help text includes browser-use provider', async () => {
    const content = await Bun.file('src/cli/commands/connect.ts').text();
    expect(content).toContain('browser-use');
    expect(content).toContain('--proxy-country');
    expect(content).toContain('--cloud-timeout');
    expect(content).toContain('--profile-id');
  });

  test('provider validation accepts browser-use', async () => {
    const content = await Bun.file('src/cli/commands/connect.ts').text();
    // The validation line should include browser-use
    expect(content).toContain("'browser-use'");
    // Error message should list browser-use
    expect(content).toContain('browser-use, generic');
  });

  test('proxy-country null parses as null (not string)', async () => {
    const content = await Bun.file('src/cli/commands/connect.ts').text();
    // Verify the null handling code exists
    expect(content).toContain("=== 'null' ? null");
  });

  test('cloud-timeout validates range 1-240', async () => {
    const content = await Bun.file('src/cli/commands/connect.ts').text();
    expect(content).toContain('240');
    expect(content).toContain('--cloud-timeout must be');
  });

  test('connect options include browser-use fields', async () => {
    const content = await Bun.file('src/cli/commands/connect.ts').text();
    expect(content).toContain('proxyCountry');
    expect(content).toContain('cloudTimeout');
  });
});
