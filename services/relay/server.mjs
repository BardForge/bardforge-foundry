import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

function tokenMatches(actual, expected) {
  if (typeof actual !== 'string' || actual.length > 256) return false;
  const a = Buffer.from(actual),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One configured room; credentials never appear in URLs or logs. */
export function createRelay({ room, publishToken, listenToken, allowedOrigins = [], maxListeners = 16 }) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(room ?? '')) throw new Error('A valid room is required');
  for (const token of [publishToken, listenToken])
    if (typeof token !== 'string' || token.length < 32 || token.length > 256)
      throw new Error('Use separate random tokens of 32–256 characters');
  if (publishToken === listenToken) throw new Error('Publisher and listener tokens must differ');
  if (!Number.isInteger(maxListeners) || maxListeners < 1 || maxListeners > 64)
    throw new Error('maxListeners must be between 1 and 64');
  const clients = new Map();
  let publisher = null;
  const server = createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 404, {
      'Content-Type': 'text/plain',
      'Cache-Control': 'no-store',
    });
    res.end(req.url === '/health' ? 'ok\n' : 'not found\n');
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  const send = (ws, data) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 262144) {
      ws.close(4008, 'Backpressure');
      return;
    }
    ws.send(JSON.stringify(data));
  };
  server.on('upgrade', (req, socket, head) => {
    if (
      req.url !== '/relay' ||
      wss.clients.size >= maxListeners + 9 ||
      (allowedOrigins.length && !allowedOrigins.includes(req.headers.origin))
    ) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (ws) => {
    const id = randomUUID();
    let role = null;
    let alive = true;
    let count = 0;
    let windowStart = Date.now();
    const authTimer = setTimeout(() => ws.close(4001, 'Authentication required'), 5000);
    ws.on('pong', () => {
      alive = true;
    });
    ws.on('error', () => {
      /* close handler removes state; do not log credentials */
    });
    ws.on('message', (raw, binary) => {
      if (Date.now() - windowStart > 10000) {
        windowStart = Date.now();
        count = 0;
      }
      if (++count > 256 || binary) {
        ws.close(4002, 'Invalid traffic');
        return;
      }
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        ws.close(4002, 'Invalid message');
        return;
      }
      if (!message || typeof message !== 'object') {
        ws.close(4002, 'Invalid message');
        return;
      }
      if (!role) {
        if (
          message.type !== 'auth' ||
          message.room !== room ||
          !['publisher', 'listener'].includes(message.role) ||
          !tokenMatches(message.token, message.role === 'publisher' ? publishToken : listenToken)
        ) {
          ws.close(4001, 'Authentication failed');
          return;
        }
        if (message.role === 'publisher' && publisher) {
          ws.close(4003, 'Publisher already connected');
          return;
        }
        if (
          message.role === 'listener' &&
          [...clients.values()].filter((c) => c.role === 'listener').length >= maxListeners
        ) {
          ws.close(4004, 'Room full');
          return;
        }
        clearTimeout(authTimer);
        role = message.role;
        clients.set(id, { ws, role });
        if (role === 'publisher') publisher = id;
        send(ws, {
          type: 'ready',
          id,
          listeners:
            role === 'publisher'
              ? [...clients].filter(([, c]) => c.role === 'listener').map(([key]) => key)
              : [],
        });
        if (role === 'listener' && publisher)
          send(clients.get(publisher).ws, { type: 'listener-joined', id });
        return;
      }
      const target = clients.get(message.to);
      if (message.type !== 'signal' || typeof message.data !== 'object' || !message.data) {
        ws.close(4002, 'Invalid message');
        return;
      }
      // A disconnected peer is normal. Role-isolation violations are not.
      if (!target) return;
      if (target.role === role || (role === 'listener' && message.to !== publisher)) {
        ws.close(4002, 'Invalid destination');
        return;
      }
      const { description, candidate } = message.data;
      const validDescription =
        description &&
        typeof description.sdp === 'string' &&
        description.type === (role === 'publisher' ? 'offer' : 'answer');
      const validCandidate = candidate && typeof candidate.candidate === 'string';
      if ((!validDescription && !validCandidate) || (description && candidate)) {
        ws.close(4002, 'Invalid signal');
        return;
      }
      send(target.ws, { type: 'signal', from: id, data: message.data });
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      if (!clients.delete(id)) return;
      if (publisher === id) publisher = null;
      for (const client of clients.values())
        if (client.role !== role) send(client.ws, { type: 'peer-left', id });
    });
    ws.checkAlive = () => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    };
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) ws.checkAlive();
  }, 15000);
  heartbeat.unref();
  return {
    server,
    async close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const relay = createRelay({
      room: process.env.BARDFORGE_ROOM,
      publishToken: process.env.BARDFORGE_PUBLISH_TOKEN,
      listenToken: process.env.BARDFORGE_LISTEN_TOKEN,
      allowedOrigins: (process.env.BARDFORGE_ORIGINS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      maxListeners: Number(process.env.BARDFORGE_MAX_LISTENERS ?? 16),
    });
    const port = Number(process.env.PORT ?? 8787);
    const host = process.env.HOST ?? '127.0.0.1';
    relay.server.listen(port, host, () =>
      console.log(`BardForge signaling relay listening on ${host}:${port}`),
    );
    const stop = () => void relay.close().then(() => process.exit(0));
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
