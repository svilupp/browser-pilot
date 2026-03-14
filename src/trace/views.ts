import type { CanonicalTraceEvent, TraceView } from './model.ts';

function takeRecent(events: CanonicalTraceEvent[], limit = 5) {
  return events.slice(-limit).map((event) => ({
    ts: event.ts,
    event: event.event,
    summary: event.summary,
    severity: event.severity,
    url: event.url,
  }));
}

export function buildTraceSummary(events: CanonicalTraceEvent[], view: TraceView) {
  switch (view) {
    case 'ws':
      return summarizeWs(events);
    case 'voice':
      return summarizeVoice(events);
    case 'console':
      return summarizeConsole(events);
    case 'permissions':
      return summarizePermissions(events);
    case 'media':
      return summarizeMedia(events);
    case 'ui':
      return summarizeUi(events);
    case 'session':
      return summarizeSession(events);
  }

  throw new Error(`Unsupported trace view: ${view}`);
}

export function buildTraceSummaries(events: CanonicalTraceEvent[]) {
  return {
    ws: summarizeWs(events),
    voice: summarizeVoice(events),
    console: summarizeConsole(events),
    permissions: summarizePermissions(events),
    media: summarizeMedia(events),
    ui: summarizeUi(events),
    session: summarizeSession(events),
  };
}

export function formatTraceSummaryPretty(summary: Record<string, unknown>): string {
  return JSON.stringify(summary, null, 2);
}

function summarizeWs(events: CanonicalTraceEvent[]) {
  const relevant = events.filter(
    (event) => event.channel === 'ws' || event.event.startsWith('ws.')
  );
  const connections = new Map<
    string,
    {
      id: string;
      url?: string;
      createdAt?: string;
      closedAt?: string;
      sent: number;
      received: number;
      lastMessages: string[];
    }
  >();

  for (const event of relevant) {
    const id = event.connectionId ?? event.requestId ?? event.traceId;
    let connection = connections.get(id);
    if (!connection) {
      connection = { id, sent: 0, received: 0, lastMessages: [] };
      connections.set(id, connection);
    }

    connection.url = event.url ?? connection.url;
    if (event.event === 'ws.connection.created') {
      connection.createdAt = event.ts;
    }
    if (event.event === 'ws.connection.closed') {
      connection.closedAt = event.ts;
    }
    if (event.event === 'ws.frame.sent') {
      connection.sent += 1;
      const payload = typeof event.data['payload'] === 'string' ? event.data['payload'] : '';
      if (payload) connection.lastMessages.push(`sent: ${payload}`);
    }
    if (event.event === 'ws.frame.received') {
      connection.received += 1;
      const payload = typeof event.data['payload'] === 'string' ? event.data['payload'] : '';
      if (payload) connection.lastMessages.push(`recv: ${payload}`);
    }
    connection.lastMessages = connection.lastMessages.slice(-3);
  }

  const values = [...connections.values()];
  const reconnects = values.reduce((count, connection) => {
    return connection.closedAt && !connection.createdAt ? count : count;
  }, 0);

  return {
    view: 'ws',
    totalEvents: relevant.length,
    connections: values.map((connection) => ({
      id: connection.id,
      url: connection.url ?? null,
      createdAt: connection.createdAt ?? null,
      closedAt: connection.closedAt ?? null,
      sent: connection.sent,
      received: connection.received,
      lastMessages: connection.lastMessages,
      connectedButSilent:
        !!connection.createdAt &&
        !connection.closedAt &&
        connection.sent + connection.received === 0,
    })),
    reconnects,
    recent: takeRecent(relevant),
  };
}

function summarizeConsole(events: CanonicalTraceEvent[]) {
  const relevant = events.filter(
    (event) =>
      event.channel === 'console' ||
      event.event.startsWith('console.') ||
      event.event === 'runtime.exception' ||
      event.event === 'runtime.unhandledRejection'
  );

  return {
    view: 'console',
    errors: relevant.filter(
      (event) =>
        event.event === 'console.error' ||
        event.event === 'runtime.exception' ||
        event.event === 'runtime.unhandledRejection'
    ).length,
    warnings: relevant.filter((event) => event.event === 'console.warn').length,
    logs: relevant.filter((event) => event.event === 'console.log').length,
    recent: takeRecent(relevant),
  };
}

function summarizePermissions(events: CanonicalTraceEvent[]) {
  const relevant = events.filter(
    (event) => event.channel === 'permission' || event.event.startsWith('permission.')
  );
  const latest = new Map<string, string>();

  for (const event of relevant) {
    const name = typeof event.data['name'] === 'string' ? event.data['name'] : null;
    const state = typeof event.data['state'] === 'string' ? event.data['state'] : null;
    if (name && state) {
      latest.set(name, state);
    }
  }

  return {
    view: 'permissions',
    states: Object.fromEntries(latest),
    changes: relevant.filter((event) => event.event === 'permission.changed').length,
    recent: takeRecent(relevant),
  };
}

function summarizeMedia(events: CanonicalTraceEvent[]) {
  const relevant = events.filter(
    (event) => event.channel === 'media' || event.event.startsWith('media.')
  );
  const liveTracks = new Map<string, string>();

  for (const event of relevant) {
    const label = typeof event.data['label'] === 'string' ? event.data['label'] : '';
    const kind = typeof event.data['kind'] === 'string' ? event.data['kind'] : '';
    const key = `${kind}:${label}`;
    if (event.event === 'media.track.started') {
      liveTracks.set(key, kind);
    }
    if (event.event === 'media.track.ended') {
      liveTracks.delete(key);
    }
  }

  return {
    view: 'media',
    tracksStarted: relevant.filter((event) => event.event === 'media.track.started').length,
    tracksEnded: relevant.filter((event) => event.event === 'media.track.ended').length,
    playbackStarted: relevant.filter((event) => event.event === 'media.playback.started').length,
    playbackStopped: relevant.filter((event) => event.event === 'media.playback.stopped').length,
    liveTracks: [...liveTracks.values()],
    recent: takeRecent(relevant),
  };
}

function summarizeVoice(events: CanonicalTraceEvent[]) {
  const relevant = events.filter(
    (event) => event.channel === 'voice' || event.event.startsWith('voice.')
  );

  return {
    view: 'voice',
    ready: relevant.filter((event) => event.event === 'voice.pipeline.ready').length,
    notReady: relevant.filter((event) => event.event === 'voice.pipeline.notReady').length,
    captureStarted: relevant.filter((event) => event.event === 'voice.capture.started').length,
    captureStopped: relevant.filter((event) => event.event === 'voice.capture.stopped').length,
    detectedAudio: relevant.filter((event) => event.event === 'voice.capture.detectedAudio').length,
    recent: takeRecent(relevant),
  };
}

function summarizeUi(events: CanonicalTraceEvent[]) {
  const relevant = events.filter(
    (event) =>
      event.channel === 'dom' || event.event.startsWith('dom.') || event.channel === 'action'
  );

  return {
    view: 'ui',
    actions: relevant.filter((event) => event.channel === 'action').length,
    domChanges: relevant.filter((event) => event.channel === 'dom').length,
    recent: takeRecent(relevant),
  };
}

function summarizeSession(events: CanonicalTraceEvent[]) {
  const byChannel = new Map<string, number>();
  const failedActions = events.filter((event) => event.event === 'action.failed').length;

  for (const event of events) {
    byChannel.set(event.channel, (byChannel.get(event.channel) ?? 0) + 1);
  }

  return {
    view: 'session',
    totalEvents: events.length,
    byChannel: Object.fromEntries(byChannel),
    failedActions,
    recent: takeRecent(events),
  };
}
