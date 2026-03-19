export interface CLICommandMeta {
  name: string;
  description: string;
  showInRootHelp: boolean;
}

export interface CLIRouteGroup {
  label: string;
  commands: string[];
  note?: string;
}

export const CLI_COMMANDS: readonly CLICommandMeta[] = [
  { name: 'quickstart', description: 'Getting started guide', showInRootHelp: true },
  { name: 'connect', description: 'Create or resume a browser session', showInRootHelp: true },
  { name: 'exec', description: 'Execute high-level actions', showInRootHelp: true },
  { name: 'eval', description: 'Run raw JavaScript as an escape hatch', showInRootHelp: true },
  { name: 'snapshot', description: 'Inspect current page with refs', showInRootHelp: true },
  { name: 'text', description: 'Extract readable page text', showInRootHelp: true },
  { name: 'page', description: 'Compact page overview', showInRootHelp: true },
  { name: 'forms', description: 'List form controls', showInRootHelp: true },
  { name: 'targets', description: 'List available browser tabs', showInRootHelp: true },
  { name: 'diagnose', description: 'Debug selectors and targeting failures', showInRootHelp: true },
  { name: 'review', description: 'Structured business state after actions', showInRootHelp: true },
  { name: 'screenshot', description: 'Capture a page screenshot', showInRootHelp: true },
  { name: 'run', description: 'Run a workflow file', showInRootHelp: true },
  {
    name: 'record',
    description: 'Record a human workflow and derive replayable output',
    showInRootHelp: true,
  },
  { name: 'trace', description: 'Inspect and analyze behavior over time', showInRootHelp: true },
  {
    name: 'audio',
    description: 'Set up, validate, and drive voice pipelines',
    showInRootHelp: true,
  },
  { name: 'env', description: 'Session and browser-environment controls', showInRootHelp: true },
  { name: 'daemon', description: 'Manage session daemon', showInRootHelp: true },
  { name: 'list', description: 'List sessions', showInRootHelp: true },
  { name: 'close', description: 'Close session', showInRootHelp: true },
  { name: 'clean', description: 'Clean old sessions and artifacts', showInRootHelp: true },
  { name: 'actions', description: 'Complete action reference', showInRootHelp: true },
] as const;

export const ROOT_HELP_COMMANDS = CLI_COMMANDS.filter((command) => command.showInRootHelp);

export const CLI_ROUTE_GROUPS: readonly CLIRouteGroup[] = [
  {
    label: 'Inspect page state',
    commands: ['snapshot', 'page', 'forms', 'review', 'text', 'targets', 'diagnose'],
  },
  {
    label: 'Act in the browser',
    commands: ['exec', 'run'],
  },
  {
    label: 'Capture a human demo',
    commands: ['record'],
  },
  {
    label: 'Analyze behavior over time',
    commands: ['trace'],
    note: '(listen is a compatibility alias)',
  },
  {
    label: 'Exercise voice/media',
    commands: ['audio'],
  },
  {
    label: 'Change browser conditions',
    commands: ['env'],
  },
] as const;
