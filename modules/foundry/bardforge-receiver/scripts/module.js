/* global Hooks, game */
import { RelayAudioClient } from './client.js';

const ID = 'bardforge-receiver';
const localize = (key) => game.i18n.localize(`BARDFORGE.${key}`);

Hooks.once('init', () => {
  for (const [key, defaultValue] of Object.entries({
    url: '',
    room: '',
    token: '',
    stun: '',
    turn: '',
    turnUsername: '',
    turnPassword: '',
  })) {
    game.settings.register(ID, key, {
      name: `BARDFORGE.${key}`,
      hint: `BARDFORGE.${key}Hint`,
      scope: 'world',
      config: true,
      restricted: true,
      type: String,
      default: defaultValue,
      requiresReload: true,
    });
  }
  game.settings.register(ID, 'relayOnly', {
    name: 'BARDFORGE.relayOnly',
    scope: 'world',
    config: true,
    restricted: true,
    type: Boolean,
    default: false,
    requiresReload: true,
  });
  game.settings.register(ID, 'volume', {
    name: 'BARDFORGE.volume',
    scope: 'client',
    config: false,
    type: Number,
    default: 0.8,
  });
});

Hooks.once('ready', () => {
  let client = null;
  let context = null;
  let gain = null;
  let source = null;
  let enabled = false;
  const panel = document.createElement('section');
  panel.id = 'bardforge-receiver';
  panel.setAttribute('aria-label', 'BardForge Receiver');
  const title = document.createElement('strong');
  title.textContent = 'BardForge';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = localize('enable');
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  status.textContent = localize('idle');
  const volume = document.createElement('input');
  volume.type = 'range';
  volume.min = '0';
  volume.max = '1';
  volume.step = '0.01';
  const savedVolume = Number(game.settings.get(ID, 'volume'));
  volume.value = String(Number.isFinite(savedVolume) ? Math.max(0, Math.min(1, savedVolume)) : 0.8);
  volume.setAttribute('aria-label', localize('volume'));
  volume.title = localize('volume');
  volume.addEventListener('input', () => {
    if (gain) gain.gain.value = Number(volume.value);
  });
  volume.addEventListener('change', () => {
    void game.settings.set(ID, 'volume', Number(volume.value));
  });
  const detach = () => {
    source?.disconnect();
    source = null;
  };
  const disable = () => {
    enabled = false;
    client?.stop();
    client = null;
    detach();
    void context?.close();
    context = null;
    gain = null;
    button.textContent = localize('enable');
    status.textContent = localize('idle');
  };
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    if (enabled) {
      disable();
      return;
    }
    button.disabled = true;
    try {
      // Resume synchronously from the player's gesture, before any network work.
      context = new AudioContext();
      const resume = context.resume();
      gain = context.createGain();
      gain.gain.value = Number(volume.value);
      gain.connect(context.destination);
      await resume;
      if (context.state !== 'running') throw new Error('audio-blocked');
      const iceServers = [];
      const stun = game.settings.get(ID, 'stun').trim();
      const turn = game.settings.get(ID, 'turn').trim();
      if (stun) iceServers.push({ urls: stun });
      if (turn)
        iceServers.push({
          urls: turn,
          username: game.settings.get(ID, 'turnUsername'),
          credential: game.settings.get(ID, 'turnPassword'),
        });
      if (game.settings.get(ID, 'relayOnly') && !turn) throw new Error('turn-required');
      client = new RelayAudioClient({
        url: game.settings.get(ID, 'url'),
        room: game.settings.get(ID, 'room'),
        token: game.settings.get(ID, 'token'),
        role: 'listener',
        iceServers,
        relayOnly: game.settings.get(ID, 'relayOnly'),
        onState: ({ state }) => {
          status.textContent = localize(state);
          if (['auth-error', 'error'].includes(state)) {
            disable();
            status.textContent = localize(state);
          }
        },
        onStream: (stream) => {
          detach();
          if (stream && context && gain) {
            source = context.createMediaStreamSource(stream);
            source.connect(gain);
          }
        },
      });
      client.start();
      enabled = true;
      button.textContent = localize('disable');
    } catch {
      disable();
      status.textContent = localize('configurationError');
    } finally {
      button.disabled = false;
    }
  });
  panel.append(title, button, volume, status);
  document.body.append(panel);
  window.addEventListener('beforeunload', disable, { once: true });
});
