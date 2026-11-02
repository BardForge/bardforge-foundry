import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { RelayAudioClient, validateConnection } from '../sdk/index.js';

const moduleRoot = new URL('../modules/foundry/bardforge-receiver/', import.meta.url);

test('receiver manifest references packaged files and does not claim live Foundry verification', async () => {
  const manifest = JSON.parse(await readFile(new URL('module.json', moduleRoot), 'utf8'));
  assert.equal(manifest.id, 'bardforge-receiver');
  assert.equal(manifest.compatibility.minimum, '13');
  assert.equal(Object.hasOwn(manifest.compatibility, 'verified'), false);
  for (const path of [
    ...manifest.esmodules,
    ...manifest.styles,
    ...manifest.languages.map((language) => language.path),
  ]) {
    assert.ok(!path.includes('..') && !path.startsWith('/'));
    await access(new URL(path, moduleRoot));
  }
  const languages = await Promise.all(
    manifest.languages.map(
      async ({ path }) => JSON.parse(await readFile(new URL(path, moduleRoot), 'utf8')).BARDFORGE,
    ),
  );
  assert.deepEqual(Object.keys(languages[0]).sort(), Object.keys(languages[1]).sort());
  for (const language of languages)
    for (const text of Object.values(language)) assert.ok(typeof text === 'string' && text.length > 0);
});

test('standalone SDK exposes the actual browser transport without a core application dependency', () => {
  assert.equal(typeof RelayAudioClient, 'function');
  assert.equal(typeof validateConnection, 'function');
  assert.equal(typeof RelayAudioClient.prototype.start, 'function');
  assert.equal(typeof RelayAudioClient.prototype.stop, 'function');
});
