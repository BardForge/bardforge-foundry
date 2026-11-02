// Real two-context Chromium RTP/audio proof; run separately: node tests/transport.browser.mjs
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { createRelay } from '../services/relay/server.mjs';

const config = {
  room: 'audio-proof',
  publishToken: randomBytes(32).toString('hex'),
  listenToken: randomBytes(32).toString('hex'),
};
let relay = createRelay(config);
await new Promise((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
const relayPort = relay.server.address().port;
const clientSource = await readFile(
  new URL('../modules/foundry/bardforge-receiver/scripts/client.js', import.meta.url),
);
const html = `<!doctype html><html><body><button id="start">Enable audio</button><script type="module">
import {RelayAudioClient} from '/client.js';
window.rms = () => { if (!window.analyser) return 0; const data = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data); return Math.sqrt(data.reduce((n,v)=>n+v*v,0)/data.length); };
document.querySelector('#start').onclick = async () => {
  window.context = new AudioContext(); await context.resume();
  let stream;
  if (config.role === 'publisher') {
    const tone = context.createOscillator(); tone.frequency.value = 440;
    const level = context.createGain(); level.gain.value = .2;
    const output = context.createMediaStreamDestination();
    tone.connect(level).connect(output); tone.start(); stream = output.stream;
  } else {
    window.volume = context.createGain(); volume.gain.value = .5;
    window.analyser = context.createAnalyser();
    const silent = context.createGain(); silent.gain.value = 0;
    volume.connect(analyser).connect(silent).connect(context.destination);
  }
  window.client = new RelayAudioClient({...config, stream, onState: s => window.transportStatus = s,
    onStream: incoming => { window.source?.disconnect(); window.source = null;
      if(incoming) { window.source = context.createMediaStreamSource(incoming); source.connect(volume); } }
  }); client.start();
};
</script></body></html>`;
const web = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/client.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/client.js' ? clientSource : html);
});
await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const publisherContext = await browser.newContext();
  const listenerContext = await browser.newContext();
  const publisher = await publisherContext.newPage();
  const listener = await listenerContext.newPage();
  const pageErrors = [];
  for (const page of [publisher, listener]) page.on('pageerror', (error) => pageErrors.push(error.message));
  for (const [page, role, token] of [
    [listener, 'listener', config.listenToken],
    [publisher, 'publisher', config.publishToken],
  ]) {
    await page.goto(`http://127.0.0.1:${web.address().port}`);
    await page.evaluate(
      (options) => {
        window.config = options;
      },
      { url: `ws://127.0.0.1:${relayPort}/relay`, role, token, room: config.room },
    );
    await page.click('#start');
  }
  await listener
    .waitForFunction(() => window.rms() > 0.02, null, { timeout: 20000 })
    .catch(async (error) => {
      for (const [label, page] of [
        ['publisher', publisher],
        ['listener', listener],
      ]) {
        console.error(
          label,
          await page.evaluate(async () => ({
            status: window.transportStatus,
            context: window.context?.state,
            time: window.context?.currentTime,
            rms: window.rms(),
            hasSource: !!window.source,
            stats: (
              await Promise.all(
                [...(window.client?.peers.values() ?? [])].map(async ({ pc }) =>
                  [...(await pc.getStats()).values()]
                    .filter((s) => ['inbound-rtp', 'outbound-rtp', 'media-source'].includes(s.type))
                    .map((s) => ({
                      type: s.type,
                      bytesSent: s.bytesSent,
                      bytesReceived: s.bytesReceived,
                      totalAudioEnergy: s.totalAudioEnergy,
                      audioLevel: s.audioLevel,
                    })),
                ),
              )
            ).flat(),
            peers: [...(window.client?.peers.values() ?? [])].map(({ pc }) => ({
              connection: pc.connectionState,
              ice: pc.iceConnectionState,
              signaling: pc.signalingState,
            })),
          })),
        );
      }
      console.error('Page errors', pageErrors);
      throw error;
    });
  const proof = await listener.evaluate(async () => {
    const pc = [...window.client.peers.values()][0].pc;
    const stats = [...(await pc.getStats()).values()].find(
      (s) => s.type === 'inbound-rtp' && s.kind === 'audio',
    );
    return {
      rms: window.rms(),
      bytesReceived: stats.bytesReceived,
      totalAudioEnergy: stats.totalAudioEnergy,
      codec: [...(await pc.getStats()).values()].find((s) => s.id === stats.codecId)?.mimeType,
    };
  });
  assert.ok(proof.bytesReceived > 0);
  assert.match(proof.codec, /opus/i);
  await listener.evaluate(() => {
    window.volume.gain.value = 0;
  });
  await listener.waitForFunction(() => window.rms() < 0.0001);
  await listener.evaluate(() => {
    window.volume.gain.value = 0.5;
  });
  await listener.waitForFunction(() => window.rms() > 0.02);
  await relay.close();
  await listener.waitForFunction(() => window.transportStatus.state === 'reconnecting');
  relay = createRelay(config);
  await new Promise((resolve) => relay.server.listen(relayPort, '127.0.0.1', resolve));
  await listener.waitForFunction(() => window.transportStatus.state === 'live' && window.rms() > 0.02, null, {
    timeout: 25000,
  });
  await publisher.evaluate(() => window.client.stop());
  await listener.waitForFunction(() => window.transportStatus.state === 'waiting' && window.rms() < 0.0001);
  assert.deepEqual(pageErrors, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        ...proof,
        checks: [
          'Opus RTP',
          'nonzero decoded waveform',
          'individual mute/restore',
          'relay restart reconnect',
          'publisher stop silences listener',
          'no page errors',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await relay.close();
  await new Promise((resolve) => web.close(resolve));
}
