import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createRelay } from '../services/relay/server.mjs';
import {
  RelayAudioClient,
  validateConnection,
} from '../modules/foundry/bardforge-receiver/scripts/client.js';

const { WebSocket } = createRequire(new URL('../services/relay/package.json', import.meta.url))('ws');
const publishToken = 'p'.repeat(48);
const listenToken = 'l'.repeat(48);
const config = { room: 'test-room', publishToken, listenToken };

function event(socket, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${name}`));
    }, 3000);
    const handler = (...args) => {
      cleanup();
      resolve(args);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(name, handler);
    };
    socket.once(name, handler);
  });
}
async function setup(t, overrides = {}) {
  const relay = createRelay({ ...config, ...overrides });
  await new Promise((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.server.address().port}/relay`;
  const connect = async () => {
    const ws = new WebSocket(url);
    await event(ws, 'open');
    return ws;
  };
  const auth = async (role) => {
    const ws = await connect();
    const reply = event(ws, 'message');
    ws.send(
      JSON.stringify({
        type: 'auth',
        role,
        room: config.room,
        token: role === 'publisher' ? publishToken : listenToken,
      }),
    );
    const [raw] = await reply;
    return { ws, message: JSON.parse(raw.toString()) };
  };
  return { relay, connect, auth, url };
}

test('relay requires distinct strong credentials', () => {
  assert.throws(() => createRelay({ ...config, listenToken: publishToken }), /must differ/);
  assert.throws(() => createRelay({ ...config, publishToken: 'short' }), /32/);
  assert.throws(() => createRelay({ ...config, maxListeners: 1000 }), /64/);
});

test('browser transport rejects insecure remote URLs and oversized credentials before connecting', () => {
  const options = { url: 'ws://example.org/relay', room: 'table', token: publishToken, role: 'publisher' };
  assert.throws(() => validateConnection(options), /secure-url-required/);
  assert.throws(
    () => validateConnection({ ...options, url: 'wss://example.org/relay?token=secret' }),
    /invalid-url/,
  );
  assert.throws(
    () => validateConnection({ ...options, url: 'wss://example.org/relay', token: 'x'.repeat(257) }),
    /invalid-token/,
  );
});

test('peer negotiation deadline survives the connecting state transition', (t) => {
  const previous = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = class {
    connectionState = 'new';
    close() {}
  };
  t.after(() => {
    if (previous) globalThis.RTCPeerConnection = previous;
    else delete globalThis.RTCPeerConnection;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new RelayAudioClient({ role: 'listener' });
  const closed = [];
  client.socket = { close: (code) => closed.push(code) };
  const peer = client.createPeer('remote');
  peer.pc.connectionState = 'connecting';
  peer.pc.onconnectionstatechange();
  t.mock.timers.tick(30000);
  assert.deepEqual(closed, [4008]);
  client.dropAll();
});

test('one failed listener is retried without closing the publisher socket or healthy peer', async (t) => {
  const previous = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = class {
    connectionState = 'new';
    closed = false;
    close() {
      this.closed = true;
    }
    addTrack() {}
    async createOffer() {
      return { type: 'offer', sdp: 'test' };
    }
    async setLocalDescription(description) {
      this.localDescription = { toJSON: () => description };
    }
  };
  t.after(() => {
    if (previous) globalThis.RTCPeerConnection = previous;
    else delete globalThis.RTCPeerConnection;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const states = [];
  const client = new RelayAudioClient({
    role: 'publisher',
    stream: { getAudioTracks: () => [] },
    onState: (state) => states.push(state),
  });
  client.running = true;
  const socketCloses = [];
  client.socket = { close: (code) => socketCloses.push(code) };
  const healthy = client.createPeer('healthy');
  healthy.pc.connectionState = 'connected';
  healthy.pc.onconnectionstatechange();
  const failing = client.createPeer('failing');
  failing.pc.connectionState = 'failed';
  failing.pc.onconnectionstatechange();
  t.mock.timers.tick(1000);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(client.peers.get('healthy'), healthy);
  assert.equal(healthy.pc.closed, false);
  assert.notEqual(client.peers.get('failing'), failing);
  assert.deepEqual(socketCloses, []);
  assert.equal(states.at(-1).state, 'live');
  assert.equal(states.at(-1).listeners, 1);
  client.dropPeer('healthy');
  client.reportPeers();
  assert.deepEqual(states.at(-1), { state: 'waiting', listeners: 0 });
  client.dropAll();
});

test('publisher can arrive after listeners; signaling is bidirectional and scoped', async (t) => {
  const { auth } = await setup(t);
  const listener = await auth('listener');
  const publisher = await auth('publisher');
  assert.deepEqual(publisher.message.listeners, [listener.message.id]);
  const received = event(listener.ws, 'message');
  publisher.ws.send(
    JSON.stringify({
      type: 'signal',
      to: listener.message.id,
      data: { description: { type: 'offer', sdp: 'test-offer' } },
    }),
  );
  const [raw] = await received;
  assert.deepEqual(JSON.parse(raw.toString()), {
    type: 'signal',
    from: publisher.message.id,
    data: { description: { type: 'offer', sdp: 'test-offer' } },
  });
  const reply = event(publisher.ws, 'message');
  listener.ws.send(
    JSON.stringify({
      type: 'signal',
      to: publisher.message.id,
      data: { description: { type: 'answer', sdp: 'test-answer' } },
    }),
  );
  assert.equal(JSON.parse((await reply)[0].toString()).data.description.type, 'answer');
  const departure = event(listener.ws, 'message');
  publisher.ws.close();
  assert.deepEqual(JSON.parse((await departure)[0].toString()), {
    type: 'peer-left',
    id: publisher.message.id,
  });
});

test('listener credential cannot publish and wrong rooms are rejected', async (t) => {
  const { connect } = await setup(t);
  for (const message of [
    { role: 'publisher', room: config.room, token: listenToken },
    { role: 'listener', room: 'other-room', token: listenToken },
  ]) {
    const ws = await connect();
    const closed = event(ws, 'close');
    ws.send(JSON.stringify({ type: 'auth', ...message }));
    assert.equal((await closed)[0], 4001);
  }
});

test('listener cannot signal another listener', async (t) => {
  const { auth } = await setup(t);
  const a = await auth('listener'),
    b = await auth('listener');
  const closed = event(a.ws, 'close');
  a.ws.send(JSON.stringify({ type: 'signal', to: b.message.id, data: { candidate: { candidate: 'test' } } }));
  assert.equal((await closed)[0], 4002);
});

test('duplicate publisher, room capacity, malformed and oversized messages are bounded', async (t) => {
  const { auth, connect } = await setup(t, { maxListeners: 1 });
  await auth('publisher');
  await auth('listener');
  for (const [role, token, expected] of [
    ['publisher', publishToken, 4003],
    ['listener', listenToken, 4004],
  ]) {
    const ws = await connect();
    const closed = event(ws, 'close');
    ws.send(JSON.stringify({ type: 'auth', room: config.room, role, token }));
    assert.equal((await closed)[0], expected);
  }
  const malformed = await connect();
  const malformedClose = event(malformed, 'close');
  malformed.send('{broken');
  assert.equal((await malformedClose)[0], 4002);
  const oversized = await connect();
  const oversizedClose = event(oversized, 'close');
  oversized.send('a'.repeat(70000));
  assert.equal((await oversizedClose)[0], 1009);
});

test('optional Origin allowlist rejects unknown browser origins before upgrade', async (t) => {
  const { url } = await setup(t, { allowedOrigins: ['https://table.example.org'] });
  const denied = new WebSocket(url, { origin: 'https://untrusted.example.org' });
  denied.on('error', () => {});
  const [error] = await event(denied, 'error');
  assert.match(error.message, /403/);
  const allowed = new WebSocket(url, { origin: 'https://table.example.org' });
  await event(allowed, 'open');
  allowed.close();
});
