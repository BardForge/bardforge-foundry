/** Shared, dependency-free browser transport. Audio uses encrypted WebRTC; WSS carries signaling only. */
export function validateConnection(options) {
  const url = new URL(options.url);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback))
    throw new Error('secure-url-required');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/relay')
    throw new Error('invalid-url');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(options.room)) throw new Error('invalid-room');
  if (typeof options.token !== 'string' || options.token.length < 32 || options.token.length > 256)
    throw new Error('invalid-token');
  if (!['publisher', 'listener'].includes(options.role)) throw new Error('invalid-role');
  if (!Array.isArray(options.iceServers ?? [])) throw new Error('invalid-ice');
  // Let the browser validate the full RTCConfiguration before opening a socket.
  const check = new RTCPeerConnection({
    iceServers: options.iceServers ?? [],
    iceTransportPolicy: options.relayOnly ? 'relay' : 'all',
  });
  check.close();
  return url.href;
}

export class RelayAudioClient {
  constructor(options) {
    this.options = options;
    this.peers = new Map();
    this.peerRetries = new Map();
    this.socket = null;
    this.running = false;
    this.attempt = 0;
    this.timer = null;
    this.watchdog = null;
  }

  start() {
    if (this.running) return;
    this.url = validateConnection(this.options);
    if (
      this.options.role === 'publisher' &&
      !this.options.stream?.getAudioTracks().some((t) => t.readyState === 'live')
    )
      throw new Error('audio-stream-required');
    this.running = true;
    this.connect();
  }

  report(state) {
    this.options.onState?.({
      state,
      listeners: [...this.peers.values()].filter((p) => p.pc.connectionState === 'connected').length,
    });
  }

  reportPeers() {
    this.report(
      [...this.peers.values()].some((peer) => peer.pc.connectionState === 'connected') ? 'live' : 'waiting',
    );
  }

  retryPeer(id, peer) {
    if (this.peers.get(id) !== peer) return;
    if (this.options.role === 'listener') {
      this.socket?.close(4008, 'Peer disconnected');
      return;
    }
    const attempts = this.peerRetries.get(id) ?? 0;
    this.dropPeer(id);
    this.reportPeers();
    if (attempts >= 3 || !this.running) return;
    this.peerRetries.set(id, attempts + 1);
    // Only this listener is renegotiated. Other players keep their live streams.
    void this.offer(id).catch(() => {
      const failed = this.peers.get(id);
      if (failed) this.dropPeer(id);
      this.reportPeers();
    });
  }

  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > 262144) {
      this.socket.close(4008, 'Backpressure');
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  connect() {
    if (!this.running) return;
    this.report(this.attempt ? 'reconnecting' : 'connecting');
    const socket = new WebSocket(this.url);
    this.socket = socket;
    let queue = Promise.resolve();
    this.watchdog = setTimeout(() => socket.close(4008, 'Connection timeout'), 15000);
    socket.onopen = () =>
      this.send({
        type: 'auth',
        role: this.options.role,
        room: this.options.room,
        token: this.options.token,
      });
    socket.onmessage = ({ data }) => {
      queue = queue
        .then(async () => {
          if (socket !== this.socket || !this.running) return;
          const message = JSON.parse(data);
          if (message.type === 'ready') {
            clearTimeout(this.watchdog);
            this.attempt = 0;
            this.report('waiting');
            for (const id of message.listeners ?? []) await this.offer(id);
          } else if (message.type === 'listener-joined' && this.options.role === 'publisher') {
            await this.offer(message.id);
          } else if (message.type === 'peer-left') {
            this.dropPeer(message.id);
            this.peerRetries.delete(message.id);
            this.reportPeers();
          } else if (message.type === 'signal') {
            try {
              await this.signal(message.from, message.data);
            } catch {
              const peer = this.peers.get(message.from);
              if (peer) this.retryPeer(message.from, peer);
            }
          }
        })
        .catch(() => {
          if (socket === this.socket) socket.close(4008, 'Negotiation failed');
        });
    };
    socket.onerror = () => {
      /* onclose owns reconnect and status */
    };
    socket.onclose = ({ code }) => {
      if (socket !== this.socket) return;
      clearTimeout(this.watchdog);
      this.socket = null;
      this.dropAll();
      if (!this.running) return;
      if ([4001, 4002, 4003].includes(code)) {
        this.running = false;
        this.report(code === 4001 ? 'auth-error' : 'error');
        return;
      }
      this.report('reconnecting');
      const delay = Math.min(15000, 750 * 2 ** Math.min(this.attempt++, 5));
      this.timer = setTimeout(() => this.connect(), delay + Math.random() * 250);
    };
  }

  createPeer(id, session = crypto.randomUUID()) {
    this.dropPeer(id);
    const pc = new RTCPeerConnection({
      iceServers: this.options.iceServers ?? [],
      iceTransportPolicy: this.options.relayOnly ? 'relay' : 'all',
    });
    const peer = { pc, session, candidates: [], timeout: null, playout: null };
    this.peers.set(id, peer);
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.send({ type: 'signal', to: id, data: { session, candidate: candidate.toJSON() } });
    };
    pc.ontrack = ({ track, streams }) => {
      if (this.options.role === 'listener' && track.kind === 'audio') {
        const stream = streams[0] ?? new MediaStream([track]);
        // Keep Chromium's remote-media playout clock running when consumers use Web Audio.
        // This element is always muted; audible output requires the consumer's user gesture.
        peer.playout = new Audio();
        peer.playout.muted = true;
        peer.playout.srcObject = stream;
        void peer.playout.play().catch(() => {
          if (this.peers.get(id) === peer) this.report('error');
        });
        this.options.onStream?.(stream);
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        clearTimeout(peer.timeout);
        this.peerRetries.delete(id);
        this.report('live');
      } else if (['failed', 'disconnected'].includes(pc.connectionState)) {
        clearTimeout(peer.timeout);
        if (this.options.role === 'listener') this.report('reconnecting');
        else this.reportPeers();
        peer.timeout = setTimeout(
          () => this.retryPeer(id, peer),
          pc.connectionState === 'failed' ? 1000 : 10000,
        );
      }
    };
    // Bound failed negotiations even when the browser remains in "connecting".
    peer.timeout = setTimeout(() => this.retryPeer(id, peer), 30000);
    return peer;
  }

  async offer(id) {
    const { pc, session } = this.createPeer(id);
    try {
      for (const track of this.options.stream.getAudioTracks()) pc.addTrack(track, this.options.stream);
      await pc.setLocalDescription(await pc.createOffer());
      if (this.peers.get(id)?.pc === pc)
        this.send({ type: 'signal', to: id, data: { session, description: pc.localDescription.toJSON() } });
    } catch {
      if (this.peers.get(id)?.pc === pc) this.dropPeer(id);
      this.reportPeers();
    }
  }

  async signal(id, data) {
    let peer = this.peers.get(id);
    if (data.description?.type === 'offer' && this.options.role === 'listener') {
      // One publisher per room. Close stale streams on a publisher replacement.
      this.dropAll();
      peer = this.createPeer(id, data.session);
      await peer.pc.setRemoteDescription(data.description);
      await peer.pc.setLocalDescription(await peer.pc.createAnswer());
      this.send({
        type: 'signal',
        to: id,
        data: { session: peer.session, description: peer.pc.localDescription.toJSON() },
      });
    } else if (data.description?.type === 'answer' && peer && this.options.role === 'publisher') {
      if (data.session !== peer.session) return;
      await peer.pc.setRemoteDescription(data.description);
      for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate);
    } else if (data.candidate && peer) {
      if (data.session !== peer.session) return;
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate);
      else if (peer.candidates.length < 64) peer.candidates.push(data.candidate);
      else throw new Error('too-many-candidates');
    }
  }

  dropPeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    clearTimeout(peer.timeout);
    peer.pc.onconnectionstatechange = null;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.close();
    if (peer.playout) {
      peer.playout.pause();
      peer.playout.srcObject = null;
    }
    this.peers.delete(id);
    if (this.options.role === 'listener') this.options.onStream?.(null);
  }

  dropAll() {
    for (const id of this.peers.keys()) this.dropPeer(id);
    this.peerRetries.clear();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    clearTimeout(this.watchdog);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
    this.dropAll();
    this.report('idle');
    // Input tracks belong to the mixer, never stop them here.
  }
}
