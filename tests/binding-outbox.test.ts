import assert from 'node:assert/strict';
import test from 'node:test';

import { resetChromeStorage } from './chrome-fake';
import { storyCardMark } from '../src/shared/story-mark';
import { videoGroupKey, type MediaItem } from '../src/shared/media';
import { getBind, persistBindings } from '../src/shared/storage';

const { flushBindingsNow, loadBindings, purgeTabBindings, selectPlaying } = await import('../src/shared/now-playing');
const { setPlaying } = await import('../src/shared/storage');

function item(id: number): MediaItem {
  return {
    id: `video-${id}`,
    url: `https://video.xx.fbcdn.net/v/t42/${id}.mp4`,
    kind: 'video',
    source: 'story',
    origin: 'graphql',
    addedAt: Date.now(),
  };
}

test('keeps simultaneous tab snapshots dirty through runtime NACK and retries per tab', async () => {
  await resetChromeStorage();
  const tabs = [881, 882];
  const runtimeHost = chrome as unknown as { runtime?: { sendMessage(message: unknown): Promise<unknown> } };
  const previousRuntime = runtimeHost.runtime;
  const attempts = new Map<number, number>();
  runtimeHost.runtime = {
    async sendMessage(raw): Promise<unknown> {
      const message = raw as { type?: string; tabId?: number; generation?: number; baseRevision?: number; state?: unknown };
      if (message.type !== 'FACESCRAP_PERSIST_BINDINGS') return { ok: true };
      const tabId = message.tabId as number;
      const count = (attempts.get(tabId) ?? 0) + 1;
      attempts.set(tabId, count);
      if (count === 1) return { ok: false, retryable: true, error: 'temporary worker NACK' };
      return persistBindings(tabId, {
        generation: message.generation as number,
        baseRevision: message.baseRevision as number,
        state: message.state as Parameters<typeof persistBindings>[1]['state'],
      });
    },
  };

  try {
    for (const tabId of tabs) {
      await loadBindings(tabId);
      const media = item(tabId);
      const durable = storyCardMark(`/stories/owner/${tabId}/`, Buffer.from(`S:_ISC:${tabId}`).toString('base64'));
      await setPlaying(tabId, { ids: [media.id], hasVideo: true, mark: durable, at: Date.now() });
      assert.deepEqual(await selectPlaying(tabId, [media]), [media]);
    }
    flushBindingsNow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(await getBind(tabs[0]), null);
    assert.equal(await getBind(tabs[1]), null);

    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    assert.equal((await getBind(tabs[0]))?.coverBind.length, 1);
    assert.equal((await getBind(tabs[1]))?.coverBind.length, 1);
    assert.deepEqual([...attempts.entries()], [[tabs[0], 2], [tabs[1], 2]]);
  } finally {
    for (const tabId of tabs) purgeTabBindings(tabId);
    if (previousRuntime === undefined) delete runtimeHost.runtime;
    else runtimeHost.runtime = previousRuntime;
  }
});

test('a binding load started before purge cannot restore its stale snapshot afterward', async () => {
  await resetChromeStorage();
  const tabId = 889;
  const media = item(tabId);
  const durable = storyCardMark(`/stories/owner/${tabId}/`, Buffer.from(`S:_ISC:${tabId}`).toString('base64'));
  const written = await persistBindings(tabId, {
    generation: 0,
    baseRevision: 0,
    state: { coverBind: [], groupCover: [], markBind: [[durable, videoGroupKey(media)]] },
  });
  assert.equal(written.ok, true);

  const key = `bind_${tabId}`;
  const snapshot = await chrome.storage.session.get(key);
  const session = chrome.storage.session;
  const realGet = session.get.bind(session);
  let release!: (value: Record<string, unknown>) => void;
  const gate = new Promise<Record<string, unknown>>((resolve) => {
    release = resolve;
  });
  let blocked = true;
  session.get = (async (keys: unknown): Promise<Record<string, unknown>> => {
    if (blocked && keys === key) {
      blocked = false;
      return gate;
    }
    return realGet(keys as string);
  }) as typeof session.get;

  try {
    const pendingLoad = loadBindings(tabId);
    await Promise.resolve();
    purgeTabBindings(tabId);
    release(snapshot);
    await pendingLoad;

    await setPlaying(tabId, { ids: [], hasVideo: true, mark: durable, at: Date.now() });
    assert.deepEqual(await selectPlaying(tabId, [media]), []);
  } finally {
    session.get = realGet;
    purgeTabBindings(tabId);
  }
});
