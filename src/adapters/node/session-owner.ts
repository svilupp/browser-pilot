import { randomUUID } from 'node:crypto';
import { connect } from '../../browser/connect.ts';
import {
  type ConnectionSessionOwnerOptions,
  ConnectionSessionOwner as PortableOwner,
} from '../../core/sessions/owner.ts';

/** Node owner defaults, including Node 18 randomness and optional transport loading. */
export class ConnectionSessionOwner extends PortableOwner {
  constructor(options: ConnectionSessionOwnerOptions = {}) {
    super({
      ...options,
      connect: options.connect ?? connect,
      idGenerator: options.idGenerator ?? randomUUID,
    });
  }
}
