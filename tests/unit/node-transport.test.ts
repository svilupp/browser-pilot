import { expect, test } from 'bun:test';
import { WebSocketServer } from 'ws';
import { createNodeTransportFactory } from '../../src/adapters/node/transport.ts';
import { createCDPClient } from '../../src/cdp/client.ts';

test('maintained Node transport authenticates and decodes real binary CDP responses', async () => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('Missing server address');
  let authorization: string | undefined;
  server.on('connection', (socket, request) => {
    authorization = request.headers.authorization;
    socket.on('message', (data) => {
      const request = JSON.parse(data.toString()) as { id: number };
      socket.send(
        Buffer.from(JSON.stringify({ id: request.id, result: { value: 'round trip' } })),
        { binary: true }
      );
    });
  });
  const cdp = await createCDPClient(`ws://127.0.0.1:${address.port}`, {
    transportFactory: await createNodeTransportFactory(),
    headers: { Authorization: 'Bearer fixture' },
  });
  try {
    expect(await cdp.send<{ value: string }>('Fixture.command')).toEqual({ value: 'round trip' });
    expect(authorization).toBe('Bearer fixture');
  } finally {
    await cdp.close();
    for (const socket of server.clients) socket.terminate();
    server.close();
  }
});
