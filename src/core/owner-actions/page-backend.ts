import { now as clockNow } from '../../runtime/clock.ts';
import { decodeObject, jsonBoolean, jsonNumber, jsonString, parseJson } from '../../utils/json.ts';
import {
  extractionExpression,
  type OwnerExtractRequest,
  type OwnerExtractResult,
  projectExtraction,
} from './extraction.ts';
import type {
  OwnerAction,
  OwnerActionContext,
  OwnerActionReceipt,
  OwnerNodeObservation,
  OwnerObservation,
} from './types.ts';

interface CDPResult {
  root?: { nodeId: number; backendNodeId: number };
  nodeIds?: number[];
  object?: { objectId?: string };
  result?: { value?: unknown };
  exceptionDetails?: unknown;
  sessionId?: string;
  frameTree?: { frame: { id: string; loaderId: string } };
  executionContextId?: number;
}
export interface BoundAction {
  action: OwnerAction;
  sessionId: string;
  documentId: string;
  objectId?: string;
  fingerprint?: string;
  pageFingerprint: string;
  observation: OwnerObservation;
  elementIdentity?: string;
}
const FACTS = `function(){const r=this.getBoundingClientRect();const h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return JSON.stringify({connected:this.isConnected,html:this.outerHTML,disabled:!!this.disabled,x:r.x,y:r.y,width:r.width,height:r.height,hit:!!h&&(h===this||this.contains(h)),visible:r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,document:performance.timeOrigin,url:location.href})}`;

/** Private owner channel. No caller-supplied expression, frame, or CDP method enters this backend. */
export class OwnerPageBackend {
  private worldDocument?: string;
  private worldContext?: number;
  private readonly worldName = `browser-pilot-owner-${crypto.randomUUID()}`;
  constructor(
    private context: OwnerActionContext,
    private readonly pageTargetId: string,
    private readonly sessionId: string
  ) {}
  useContext(context: OwnerActionContext): void {
    this.context = context;
  }
  static async attach(
    context: OwnerActionContext,
    pageTargetId: string
  ): Promise<OwnerPageBackend> {
    const result = (await context.send('Target.attachToTarget', {
      targetId: pageTargetId,
      flatten: true,
    })) as CDPResult;
    if (!result.sessionId) throw new Error('Owner could not attach exact page target');
    return new OwnerPageBackend(context, pageTargetId, result.sessionId);
  }
  private async send(method: string, params: Record<string, unknown> = {}): Promise<CDPResult> {
    this.context.assertCurrent?.();
    let payload = params;
    if (method === 'Runtime.evaluate') payload = { ...params, contextId: await this.ensureWorld() };
    if (method === 'DOM.resolveNode')
      payload = { ...params, executionContextId: await this.ensureWorld() };
    return (await this.context.send(method, payload, this.sessionId)) as CDPResult;
  }
  private async ensureWorld(): Promise<number> {
    const tree = await this.send('Page.getFrameTree');
    const frame = tree.frameTree?.frame;
    if (!frame?.id || !frame.loaderId) throw new Error('Owner main document frame unavailable');
    const document = `${frame.id}:${frame.loaderId}`;
    if (this.worldDocument !== document || this.worldContext === undefined) {
      const world = await this.send('Page.createIsolatedWorld', {
        frameId: frame.id,
        worldName: this.worldName,
      });
      if (!world.executionContextId) throw new Error('Owner isolated world unavailable');
      this.worldDocument = document;
      this.worldContext = world.executionContextId;
    }
    return this.worldContext;
  }
  async observe(): Promise<OwnerObservation> {
    const root = await this.send('DOM.getDocument', { depth: 0 });
    const state = await this.send('Runtime.evaluate', {
      expression:
        'JSON.stringify({url:location.href,title:document.title,timeOrigin:performance.timeOrigin})',
      returnByValue: true,
    });
    const raw = decodeObject(parseJson(String(state.result?.value)), {
      url: jsonString,
      title: jsonString,
      timeOrigin: jsonNumber,
    });
    if (!root.root || !Number.isFinite(raw.timeOrigin))
      throw new Error('Document identity unavailable');
    const currentRoot = await this.send('DOM.getDocument', { depth: 0 });
    if (currentRoot.root?.backendNodeId !== root.root.backendNodeId)
      throw new Error('Owner observation document changed');
    const url = new URL(raw.url);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return {
      pageTargetId: this.pageTargetId,
      documentId: `${this.pageTargetId}:${root.root.backendNodeId}:${raw.timeOrigin}`,
      url: url.href,
      title: '',
      text: '',
      observedAt: clockNow(),
    };
  }
  async project(
    kind: 'state' | 'snapshot' | 'element',
    selector: string | undefined,
    redact: (value: string) => string
  ): Promise<OwnerObservation> {
    const observation = await this.observe();
    if (kind === 'state') return observation;
    const expression = `(()=>{const selector=${JSON.stringify(selector ?? null)}; const excluded='input,textarea,select,[contenteditable],[data-sensitive],[data-secret],[data-private],script,style';const safeText=e=>{const c=e.cloneNode(true);for(const n of c.querySelectorAll(excluded))n.remove();return c.textContent?.slice(0,10000)||''};const css=e=>{const p=[];while(e&&e!==document.documentElement){const parent=e.parentElement;if(!parent)break;p.unshift(e.tagName.toLowerCase()+':nth-child('+(Array.prototype.indexOf.call(parent.children,e)+1)+')');e=parent;}return 'html>'+p.join('>')};const elements=selector?Array.from(document.querySelectorAll(selector)):Array.from(document.querySelectorAll('button,a,input,select,textarea,[role],[tabindex]'));if(elements.length>1000)throw Error('Owner projection exceeds bound');return elements.map(e=>{const r=e.getBoundingClientRect();const secret=e.closest(excluded);const text=secret?'':safeText(e);return {selector:css(e),role:e.getAttribute('role')||({BUTTON:'button',A:'link',INPUT:'textbox',SELECT:'combobox',TEXTAREA:'textbox'}[e.tagName]||'generic'),name:secret?'':(e.getAttribute('aria-label')||text),text,visible:r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden',enabled:!e.disabled,boundingBox:r.width>0&&r.height>0?{x:r.x,y:r.y,width:r.width,height:r.height}:null}})})()`;
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails || !Array.isArray(result.result?.value))
      throw new Error('Owner projection unavailable');
    if ((await this.observe()).documentId !== observation.documentId)
      throw new Error('Owner projection document changed');
    const nodes = (result.result.value as OwnerNodeObservation[]).map((node) => ({
      ...node,
      name: redact(node.name),
      text: redact(node.text),
    }));
    if (kind === 'snapshot') return { ...observation, nodes };
    return {
      ...observation,
      element: {
        exists: nodes.length > 0,
        visible: nodes.some((node) => node.visible),
        count: nodes.length,
        text: nodes.map((node) => node.text).join('\n'),
        boundingBox: nodes.length === 1 ? (nodes[0]?.boundingBox ?? null) : null,
      },
    };
  }
  async extract(
    request: OwnerExtractRequest,
    redact: (text: string) => string
  ): Promise<OwnerExtractResult> {
    const before = await this.observe();
    const fingerprint = await this.pageFingerprint();
    const result = await this.send('Runtime.evaluate', {
      expression: extractionExpression(request),
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error('Owner extraction unavailable');
    const after = await this.observe();
    if (before.documentId !== after.documentId || fingerprint !== (await this.pageFingerprint()))
      throw new Error('Owner extraction document changed');
    return projectExtraction(request, result.result?.value, redact, before.documentId);
  }
  private async pageFingerprint(): Promise<string> {
    const result = await this.send('Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML',
      returnByValue: true,
    });
    if (typeof result.result?.value !== 'string' || result.result.value.length > 2_000_000)
      throw new Error('Owner document evidence exceeds bound');
    return result.result.value;
  }
  async capture(action: OwnerAction): Promise<BoundAction> {
    const observation = await this.observe();
    const pageFingerprint = await this.pageFingerprint();
    if (action.kind === 'goto')
      return {
        action,
        pageFingerprint,
        sessionId: this.sessionId,
        documentId: observation.documentId,
        observation,
      };
    const root = await this.send('DOM.getDocument', { depth: 0 });
    const found = await this.send('DOM.querySelectorAll', {
      nodeId: root.root?.nodeId,
      selector: action.selector,
    });
    if (found.nodeIds?.length !== 1) throw new Error('Owner target must match exactly one element');
    const object = await this.send('DOM.resolveNode', { nodeId: found.nodeIds[0] });
    const objectId = object.object?.objectId;
    if (!objectId) throw new Error('Owner target unavailable');
    const fingerprint = await this.fingerprint(objectId);
    const facts = decodeObject(parseJson(fingerprint), {
      connected: jsonBoolean,
      disabled: jsonBoolean,
      visible: jsonBoolean,
      hit: jsonBoolean,
    });
    if (!facts.connected || facts.disabled || !facts.visible || !facts.hit)
      throw new Error('Owner target is not actionable in the viewport');
    return {
      action,
      pageFingerprint,
      sessionId: this.sessionId,
      documentId: observation.documentId,
      observation,
      objectId,
      fingerprint,
      elementIdentity: crypto.randomUUID(),
    };
  }
  private async fingerprint(objectId: string): Promise<string> {
    const result = await this.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: FACTS,
      returnByValue: true,
    });
    if (result.exceptionDetails || typeof result.result?.value !== 'string')
      throw new Error('Owner target became unavailable');
    return result.result.value;
  }
  async current(bound: BoundAction): Promise<boolean> {
    const observation = await this.observe();
    if (
      observation.documentId !== bound.documentId ||
      (await this.pageFingerprint()) !== bound.pageFingerprint
    )
      return false;
    return !bound.objectId || (await this.fingerprint(bound.objectId)) === bound.fingerprint;
  }
  async release(bound: BoundAction): Promise<void> {
    if (bound.objectId)
      await this.send('Runtime.releaseObject', { objectId: bound.objectId }).catch(() => undefined);
  }
  async detach(cleanupSend?: OwnerActionContext['send']): Promise<void> {
    if (!cleanupSend) return;
    await cleanupSend('Target.detachFromTarget', { sessionId: this.sessionId }).catch(
      () => undefined
    );
  }
  async execute(bound: BoundAction): Promise<OwnerActionReceipt> {
    const receipt: OwnerActionReceipt = {
      dispatchState: 'not_dispatched',
      retrySafe: true,
      inputEventsSent: [],
      assurance: 'owner-serialized-prechecked-native',
    };
    const effect = async (method: string, params: Record<string, unknown>) => {
      const previous = receipt.dispatchState;
      const previousRetry = receipt.retrySafe;
      receipt.retrySafe = false;
      receipt.dispatchState = 'unknown';
      receipt.inputEventsSent.push(method);
      try {
        await this.send(method, params);
        receipt.dispatchState = 'dispatched';
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'dispatchState' in error &&
          error.dispatchState === 'not_dispatched'
        ) {
          receipt.dispatchState = previous;
          receipt.retrySafe = previousRetry;
          receipt.inputEventsSent.pop();
        }
        throw error;
      }
    };
    try {
      if (!(await this.current(bound))) return { ...receipt, reason: 'stale_evidence' };
      const action = bound.action;
      if (action.kind === 'goto') {
        await effect('Page.navigate', { url: action.url });
      } else {
        const facts = decodeObject(parseJson(bound.fingerprint ?? '{}'), {
          x: jsonNumber,
          y: jsonNumber,
          width: jsonNumber,
          height: jsonNumber,
        });
        const x = facts.x + facts.width / 2;
        const y = facts.y + facts.height / 2;
        if (action.kind === 'click' || action.kind === 'hover') {
          await effect('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
          if (action.kind === 'click') {
            await effect('Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x,
              y,
              button: 'left',
              clickCount: 1,
            });
            await effect('Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x,
              y,
              button: 'left',
              clickCount: 1,
            });
          }
        } else if (action.kind === 'type' || action.kind === 'fill' || action.kind === 'press') {
          await effect('DOM.focus', { objectId: bound.objectId });
          if (action.kind === 'fill') {
            await effect('Input.dispatchKeyEvent', {
              type: 'keyDown',
              key: 'a',
              code: 'KeyA',
              commands: ['selectAll'],
              windowsVirtualKeyCode: 65,
            });
            await effect('Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: 'a',
              code: 'KeyA',
              commands: ['selectAll'],
              windowsVirtualKeyCode: 65,
            });
          }
          if (action.kind === 'press') {
            const keys: Record<
              string,
              { code: string; windowsVirtualKeyCode: number; text?: string }
            > = {
              Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
              Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
              Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
              Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
              Delete: { code: 'Delete', windowsVirtualKeyCode: 46 },
              ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
              ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
              ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
              ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
              Home: { code: 'Home', windowsVirtualKeyCode: 36 },
              End: { code: 'End', windowsVirtualKeyCode: 35 },
            };
            const key = keys[action.key];
            if (!key) throw new Error('Unsupported owner key');
            await effect('Input.dispatchKeyEvent', { type: 'keyDown', key: action.key, ...key });
            await effect('Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: action.key,
              code: key.code,
              windowsVirtualKeyCode: key.windowsVirtualKeyCode,
            });
          } else {
            await effect('Input.insertText', { text: action.value });
            if (action.kind === 'fill' && action.verify !== false) {
              const result = await this.send('Runtime.callFunctionOn', {
                objectId: bound.objectId,
                functionDeclaration:
                  'function(){return typeof this.value==="string"?this.value:null}',
                returnByValue: true,
              });
              const actual = result.result?.value;
              const normalize = (value: string) => value.trim().replace(/\s+/g, ' ');
              if (
                typeof actual !== 'string' ||
                (action.verify === 'exact'
                  ? actual !== action.value
                  : normalize(actual) !== normalize(action.value))
              )
                receipt.reason = 'verification_failed';
            }
          }
        } else return { ...receipt, reason: 'unsupported_action' };
      }
    } catch {
      receipt.reason =
        receipt.dispatchState === 'not_dispatched' ? 'preparation_failed' : 'dispatch_failed';
    }
    return receipt;
  }
}
