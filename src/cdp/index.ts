/**
 * CDP module exports
 */

export { type CDPClient, type CDPClientOptions, CDPError, createCDPClient } from './client.ts';
export * from './protocol.ts';
export { createTransport, type Transport, type TransportOptions } from './transport.ts';
