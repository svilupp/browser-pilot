/**
 * CDP module exports
 */

export {
  type CDPClient,
  type CDPClientOptions,
  CDPError,
  type CDPSendOptions,
  createCDPClient,
  createCDPClientFromTransport,
  type TargetAttachedInfo,
} from './client.ts';
export * from './protocol.ts';
export { createSessionScopedCDP } from './session-scope.ts';
export { createTransport, type Transport, type TransportOptions } from './transport.ts';
