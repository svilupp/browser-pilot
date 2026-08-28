import type { Page } from '../browser/page.ts';
import type { WebMCPListResult, WebMCPStatus, WebMCPToolDescriptor } from './types.ts';

interface WebMCPPageProbe {
  status: WebMCPStatus;
  tools: WebMCPToolDescriptor[];
}

function statusFromPage(page: Page): Promise<WebMCPPageProbe> {
  return page.evaluate<WebMCPPageProbe>(`(async () => {
    const context = document.modelContext ?? navigator.modelContext;
    const secureContext = window.isSecureContext === true;
    const originAgentCluster = typeof window.originAgentCluster === 'boolean'
      ? window.originAgentCluster
      : null;
    const crossOriginIsolated = window.crossOriginIsolated === true;
    let toolsPolicy = null;
    try {
      if (document.permissionsPolicy?.allowsFeature) {
        toolsPolicy = document.permissionsPolicy.allowsFeature('tools');
      } else if (document.featurePolicy?.allowsFeature) {
        toolsPolicy = document.featurePolicy.allowsFeature('tools');
      }
    } catch (_) {}

    const status = {
      available: !!context,
      url: location.href,
      secureContext,
      originAgentCluster,
      crossOriginIsolated,
      toolsPolicy,
      ...(!context ? {
        reason: !secureContext
          ? 'WebMCP requires a secure context (HTTPS or localhost).'
          : originAgentCluster === false
            ? 'WebMCP requires an origin-keyed agent cluster; do not opt out with document.domain or Origin-Agent-Cluster: ?0.'
          : 'document.modelContext is unavailable. Enable WebMCP in a supported Chrome build.'
      } : {})
    };
    if (!context) return { status, tools: [] };
    if (toolsPolicy === false) {
      status.reason = 'WebMCP is blocked by the page\\'s "tools" Permissions Policy.';
      return { status, tools: [] };
    }

    let rawTools;
    try {
      rawTools = await context.getTools();
    } catch (error) {
      status.reason = 'WebMCP tool discovery failed: ' + String(error);
      return { status, tools: [] };
    }
    const tools = rawTools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: (() => {
        if (typeof tool.inputSchema !== 'string') return tool.inputSchema;
        try { return JSON.parse(tool.inputSchema); } catch (_) { return tool.inputSchema; }
      })(),
      origin: tool.origin,
      annotations: tool.annotations
        ? {
            readOnlyHint: tool.annotations.readOnlyHint,
            untrustedContentHint: tool.annotations.untrustedContentHint,
          }
        : undefined,
    }));
    return { status, tools };
  })()`);
}

export async function webmcpStatus(page: Page): Promise<WebMCPStatus> {
  return (await statusFromPage(page)).status;
}

export async function webmcpList(
  page: Page,
  fromOrigins: string[] = []
): Promise<WebMCPListResult> {
  if (fromOrigins.length === 0) return statusFromPage(page);

  return page.evaluate<WebMCPPageProbe>(`(async () => {
    const context = document.modelContext ?? navigator.modelContext;
    const secureContext = window.isSecureContext === true;
    const originAgentCluster = typeof window.originAgentCluster === 'boolean'
      ? window.originAgentCluster
      : null;
    const crossOriginIsolated = window.crossOriginIsolated === true;
    let toolsPolicy = null;
    try {
      toolsPolicy = document.permissionsPolicy?.allowsFeature
        ? document.permissionsPolicy.allowsFeature('tools')
        : null;
    } catch (_) {}
    const status = {
      available: !!context,
      url: location.href,
      secureContext,
      originAgentCluster,
      crossOriginIsolated,
      toolsPolicy,
      ...(!context ? {
        reason: !secureContext
          ? 'WebMCP requires a secure context (HTTPS or localhost).'
          : originAgentCluster === false
            ? 'WebMCP requires an origin-keyed agent cluster; do not opt out with document.domain or Origin-Agent-Cluster: ?0.'
            : 'document.modelContext is unavailable. Enable WebMCP in a supported Chrome build.'
      } : {})
    };
    if (!context) return { status, tools: [] };
    if (toolsPolicy === false) {
      status.reason = 'WebMCP is blocked by the page\\'s "tools" Permissions Policy.';
      return { status, tools: [] };
    }
    let rawTools;
    try {
      rawTools = await context.getTools({ fromOrigins: ${JSON.stringify(fromOrigins)} });
    } catch (error) {
      status.reason = 'WebMCP tool discovery failed: ' + String(error);
      return { status, tools: [] };
    }
    return {
      status,
      tools: rawTools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: (() => {
          if (typeof tool.inputSchema !== 'string') return tool.inputSchema;
          try { return JSON.parse(tool.inputSchema); } catch (_) { return tool.inputSchema; }
        })(),
        origin: tool.origin,
        annotations: tool.annotations
          ? {
              readOnlyHint: tool.annotations.readOnlyHint,
              untrustedContentHint: tool.annotations.untrustedContentHint,
            }
          : undefined,
      })),
    };
  })()`);
}

export async function webmcpCall(
  page: Page,
  name: string,
  input: unknown,
  options: {
    origin?: string;
    fromOrigins?: string[];
    allowMutation?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}
): Promise<{ result: unknown; tool: WebMCPToolDescriptor }> {
  if (options.signal?.aborted) {
    throw new Error('WebMCP tool invocation aborted');
  }

  const listed = await webmcpList(page, options.fromOrigins ?? []);
  const matchingTools = listed.tools.filter(
    (candidate) =>
      candidate.name === name && (!options.origin || candidate.origin === options.origin)
  );
  if (matchingTools.length > 1 && !options.origin) {
    throw new Error(
      `WebMCP tool ${JSON.stringify(name)} is exposed by multiple origins. ` +
        'Repeat with --origin <origin> after reviewing the tool list.'
    );
  }
  const tool = matchingTools[0];
  if (!tool) {
    throw new Error(
      `WebMCP tool ${JSON.stringify(name)} was not found on ${listed.status.url}. ` +
        'Run "bp webmcp list" again after navigation.'
    );
  }

  if (tool.annotations?.readOnlyHint !== true && options.allowMutation !== true) {
    throw new Error(
      `WebMCP tool ${JSON.stringify(name)} is not marked read-only. ` +
        'Repeat with --confirm-mutation after reviewing its description and input schema.'
    );
  }

  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error('WebMCP timeout must be positive');
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('WebMCP tool input must be a JSON object');
  }

  // Chrome 151 still accepts serialized JSON while the current draft accepts
  // an object. Native Chrome exposes executeTool.length === 2; the draft IDL
  // has one required parameter. Select before invoking so a mutating tool is
  // never retried across API generations.
  const serializedInput = JSON.stringify(input ?? null);
  if (serializedInput === undefined) throw new Error('WebMCP tool input is not JSON-serializable');
  const executionId =
    globalThis.crypto?.randomUUID?.() ??
    `webmcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const expression = `(async () => {
    const context = document.modelContext ?? navigator.modelContext;
    if (!context) throw new Error('document.modelContext is unavailable.');
    const tools = await context.getTools({ fromOrigins: ${JSON.stringify(options.fromOrigins ?? [])} });
    const matchingTools = tools.filter((candidate) => candidate.name === ${JSON.stringify(name)} &&
      ${options.origin ? `candidate.origin === ${JSON.stringify(options.origin)}` : 'true'});
    if (matchingTools.length > 1 && ${options.origin ? 'false' : 'true'}) {
      throw new Error('WebMCP tool is exposed by multiple origins; select an exact origin.');
    }
    const tool = matchingTools[0];
    if (!tool) throw new Error('WebMCP tool disappeared before invocation.');
    if (tool.annotations?.readOnlyHint !== true && ${options.allowMutation === true ? 'false' : 'true'}) {
      throw new Error('WebMCP tool changed and is not marked read-only.');
    }
    const controllers = globalThis.__browserPilotWebMCPControllers ??=
      new Map();
    const controller = new AbortController();
    controllers.set(${JSON.stringify(executionId)}, controller);
    const timeout = setTimeout(() => {
      controller.abort(new DOMException(
        ${JSON.stringify(`WebMCP tool timed out after ${timeoutMs}ms`)},
        'AbortError'
      ));
    }, ${timeoutMs});
    try {
      const inputObject = ${serializedInput};
      const inputArguments = context.executeTool.length >= 2
        ? JSON.stringify(inputObject)
        : inputObject;
      const rawResult = await context.executeTool(tool, inputArguments, {
        signal: controller.signal,
      });
      return {
        rawResult,
        tool: {
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: (() => {
            if (typeof tool.inputSchema !== 'string') return tool.inputSchema;
            try { return JSON.parse(tool.inputSchema); } catch (_) { return tool.inputSchema; }
          })(),
          origin: tool.origin,
          annotations: tool.annotations ? {
            readOnlyHint: tool.annotations.readOnlyHint,
            untrustedContentHint: tool.annotations.untrustedContentHint,
          } : undefined,
        },
      };
    } finally {
      clearTimeout(timeout);
      controllers.delete(${JSON.stringify(executionId)});
    }
  })()`;

  const cancelExecution = (message: string): void => {
    void page
      .evaluate(`(() => {
      const controller = globalThis.__browserPilotWebMCPControllers?.get(${JSON.stringify(executionId)});
      controller?.abort(new DOMException(${JSON.stringify(message)}, 'AbortError'));
    })()`)
      .catch(() => {});
  };
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const message = `WebMCP tool timed out after ${timeoutMs}ms`;
      cancelExecution(message);
      reject(new Error(message));
    }, timeoutMs);
  });
  const abortPromise = new Promise<never>((_, reject) => {
    if (!options.signal) return;
    abortHandler = () => {
      cancelExecution('WebMCP tool invocation aborted');
      reject(new Error('WebMCP tool invocation aborted'));
    };
    if (options.signal.aborted) {
      abortHandler();
      return;
    }
    options.signal.addEventListener('abort', abortHandler, { once: true });
  });
  let evaluated: { rawResult: unknown; tool: WebMCPToolDescriptor };
  try {
    evaluated = await Promise.race([
      page.evaluate<{ rawResult: unknown; tool: WebMCPToolDescriptor }>(expression),
      timeoutPromise,
      abortPromise,
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (abortHandler) options.signal?.removeEventListener('abort', abortHandler);
  }
  let result = evaluated.rawResult;
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result);
    } catch {
      // A plain string is a valid tool result in older experimental builds.
    }
  }
  return { result, tool: evaluated.tool ?? tool };
}

export type {
  WebMCPListResult,
  WebMCPStatus,
  WebMCPToolAnnotations,
  WebMCPToolDescriptor,
} from './types.ts';
