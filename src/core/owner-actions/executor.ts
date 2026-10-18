import { now as clockNow } from '../../runtime/clock.ts';
import { validateExtraction } from './extraction.ts';
import { type BoundAction, OwnerPageBackend } from './page-backend.ts';
import { evaluateOwnerPolicy, observeOwnerPolicy } from './policy.ts';
import type {
  OwnerAction,
  OwnerActionCapabilities,
  OwnerActionContext,
  OwnerActionPolicy,
  OwnerActionReceipt,
  OwnerActionService,
  OwnerApproval,
  PreparedAction,
} from './types.ts';

const ACTIONS = ['goto', 'click', 'hover', 'fill', 'type', 'press'] as const;
const CAPABILITIES: OwnerActionCapabilities = {
  version: 1,
  profile: 'strict',
  assurance: 'owner-serialized-prechecked-native',
  actions: ACTIONS,
  reads: ['state', 'snapshot', 'element', 'extract'],
  images: false,
  evidence: 'structural-with-trusted-text-redaction',
};
interface Entry {
  grant: string;
  prepared: PreparedAction;
  bound: BoundAction;
  backend: OwnerPageBackend;
  expires: number;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid owner action request');
  return value as Record<string, unknown>;
}
function actionFrom(value: unknown): OwnerAction {
  const action = record(value);
  if (!ACTIONS.includes(action['kind'] as (typeof ACTIONS)[number]))
    throw new Error('Unsupported owner action');
  if (action['kind'] === 'goto') {
    const url = new URL(String(action['url']));
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new Error('Owner navigation requires HTTP(S)');
  } else if (
    typeof action['selector'] !== 'string' ||
    !action['selector'].trim() ||
    action['selector'].length > 4096
  )
    throw new Error('Owner action requires exact CSS selector');
  if (
    (action['kind'] === 'fill' || action['kind'] === 'type') &&
    typeof action['value'] !== 'string'
  )
    throw new Error('Owner action value required');
  if (
    action['kind'] === 'press' &&
    (typeof action['key'] !== 'string' ||
      ![
        'Enter',
        'Tab',
        'Escape',
        'Backspace',
        'Delete',
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'Home',
        'End',
      ].includes(action['key']))
  )
    throw new Error('Owner key required');
  if (
    action['kind'] === 'fill' &&
    action['verify'] !== undefined &&
    action['verify'] !== false &&
    action['verify'] !== 'exact' &&
    action['verify'] !== 'normalized'
  )
    throw new Error('Invalid owner fill verification');
  const kind = action['kind'];
  if (kind === 'goto') return { kind, url: String(action['url']) };
  const selector = String(action['selector']);
  if (kind === 'click' || kind === 'hover') return { kind, selector };
  if (kind === 'press') return { kind, selector, key: String(action['key']) };
  if (kind === 'type') return { kind, selector, value: String(action['value']) };
  if (kind === 'fill') {
    const verify = action['verify'];
    if (verify === undefined || verify === false || verify === 'exact' || verify === 'normalized')
      return {
        kind,
        selector,
        value: String(action['value']),
        ...(verify === undefined ? {} : { verify }),
      };
  }
  throw new Error('Unsupported owner action');
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}

/** Grant authority stays in the daemon. This module only retains action evidence and one-use approvals. */
export function createOwnerActionService(options: {
  policy: OwnerActionPolicy;
}): OwnerActionService {
  const policy = {
    ...options.policy,
    allowedActions: [...options.policy.allowedActions],
    allowedNavigationOrigins: options.policy.allowedNavigationOrigins
      ? [...options.policy.allowedNavigationOrigins]
      : undefined,
  };
  if (!policy.id || !policy.version || !['shadow', 'enforce'].includes(policy.mode))
    throw new Error('Trusted owner policy required');
  const prepared = new Map<string, Entry>();
  const approved = new Map<string, Entry>();
  const backends = new Map<string, Promise<OwnerPageBackend>>();
  const busy = new Set<string>();
  const grantKey = (context: OwnerActionContext) =>
    `${context.grant.ownerEpoch}:${context.grant.grantId}:`;
  const assertEntry = (entry: Entry | undefined, context: OwnerActionContext): Entry => {
    context.assertCurrent?.();
    if (!entry || entry.grant !== grantKey(context) || entry.expires < clockNow())
      throw new Error('Unknown, expired, or foreign owner handle');
    return entry;
  };
  return {
    rawAllowed: false,
    async revoke(grantId, cleanupSend) {
      for (const [key, entry] of prepared)
        if (entry.grant.includes(`:${grantId}:`)) prepared.delete(key);
      for (const [key, entry] of approved)
        if (entry.grant.includes(`:${grantId}:`)) approved.delete(key);
      const cleanup: Promise<void>[] = [];
      for (const [key, backend] of backends)
        if (key.includes(`:${grantId}:`)) {
          backends.delete(key);
          cleanup.push(backend.then((value) => value.detach(cleanupSend)).catch(() => undefined));
        }
      await Promise.all(cleanup);
    },
    async dispatch(method, raw, context) {
      context.assertCurrent?.();
      if (method === 'owner.action.capabilities') return CAPABILITIES;
      const params = record(raw);
      const grant = grantKey(context);
      if (busy.has(grant)) throw new Error('Owner logical action is already in progress');
      busy.add(grant);
      try {
        if (
          method === 'owner.action.observe' ||
          method === 'owner.action.prepare' ||
          method === 'owner.action.extract'
        ) {
          if (typeof params['pageTargetId'] !== 'string' || !params['pageTargetId'])
            throw new Error('Exact owner page target required');
          const key = `${grant}:${params['pageTargetId']}`;
          let promise = backends.get(key);
          if (!promise) {
            promise = OwnerPageBackend.attach(context, params['pageTargetId']);
            backends.set(key, promise);
          }
          const backend = await promise;
          backend.useContext(context);
          if (method === 'owner.action.extract')
            return backend.extract(
              validateExtraction(params, policy.allowValueReads === true),
              policy.redactText ?? (() => '')
            );
          if (method === 'owner.action.observe') {
            if (!['state', 'snapshot', 'element'].includes(String(params['kind'])))
              throw new Error('Unsupported owner read; raw evaluation is prohibited');
            if (params['kind'] === 'element' && typeof params['selector'] !== 'string')
              throw new Error('Owner element selector required');
            return backend.project(
              params['kind'] as 'state' | 'snapshot' | 'element',
              typeof params['selector'] === 'string' ? params['selector'] : undefined,
              policy.redactText ?? (() => '')
            );
          }
          const action = actionFrom(params['action']);
          if (!policy.allowedActions.includes(action['kind']))
            throw new Error('Action forbidden by installed owner policy');
          if (
            action.kind === 'goto' &&
            policy.allowedNavigationOrigins &&
            !policy.allowedNavigationOrigins.includes(new URL(action.url).origin)
          )
            throw new Error('Navigation forbidden by installed owner policy');
          const destination = action.kind === 'goto' ? new URL(action.url) : undefined;
          if (destination) {
            destination.username = '';
            destination.password = '';
            destination.search = '';
            destination.hash = '';
          }
          const bound = await backend.capture(action);
          const target =
            action.kind === 'goto'
              ? undefined
              : await backend.project('element', action.selector, policy.redactText ?? (() => ''));
          if (!(await backend.current(bound))) {
            await backend.release(bound);
            throw new Error('Owner evidence changed during preparation');
          }
          if (prepared.size + approved.size >= 64) {
            await backend.release(bound);
            throw new Error('Owner prepared action capacity exceeded');
          }
          const handle = crypto.randomUUID();
          const description: PreparedAction = frozen({
            preparedId: handle,
            pageTargetId: params['pageTargetId'],
            documentId: bound.documentId,
            elementIdentity: bound.elementIdentity,
            policyVersion: policy.version,
            assurance: CAPABILITIES.assurance,
            evidence: {
              ...bound.observation,
              action: action['kind'],
              target: target?.element?.text,
              destination: destination?.href,
            },
          });
          prepared.set(handle, {
            grant,
            prepared: description,
            bound,
            backend,
            expires: clockNow() + 30_000,
          });
          return description;
        }
        if (method === 'owner.action.authorize') {
          const id = String(params['preparedId']);
          const entry = assertEntry(prepared.get(id), context);
          prepared.delete(id);
          entry.backend.useContext(context);
          let verdict: OwnerApproval;
          if (policy.mode === 'shadow') {
            void evaluateOwnerPolicy(policy, entry.prepared).then((result) =>
              observeOwnerPolicy(policy, result)
            );
            verdict = { verdict: 'allow', reason: 'shadow_pending' };
          } else verdict = await evaluateOwnerPolicy(policy, entry.prepared);
          context.assertCurrent?.();
          if (!(await entry.backend.current(entry.bound)))
            verdict = { verdict: 'unknown', reason: 'stale_evidence' };
          if (policy.mode !== 'shadow' || verdict.verdict !== 'allow')
            observeOwnerPolicy(policy, verdict);
          if (verdict.verdict !== 'allow') {
            await entry.backend.release(entry.bound);
            return verdict;
          }
          const approvalId = crypto.randomUUID();
          approved.set(approvalId, entry);
          return { ...verdict, approvalId };
        }
        if (method === 'owner.action.dispatch') {
          const id = String(params['approvalId']);
          const entry = assertEntry(approved.get(id), context);
          approved.delete(id);
          entry.backend.useContext(context);
          try {
            return await entry.backend.execute(entry.bound);
          } finally {
            await entry.backend.release(entry.bound);
          }
        }
        throw new Error('Unsupported owner action method');
      } finally {
        busy.delete(grant);
      }
    },
  };
}
export type { OwnerActionReceipt };
