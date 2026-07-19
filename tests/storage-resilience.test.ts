import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { resetChromeStorage } from './chrome-fake';
import { classifyNetworkRequest, videoGroupKey, type MediaItem } from '../src/shared/media';
import { storyCardMark } from '../src/shared/story-mark';

const {
  addMedia,
  addSaved,
  clearTab,
  ensureCaptureHeadroom,
  getMedia,
  getPlaying,
  getRecent,
  getSaved,
  playingRetentionIdentity,
  setPlaying,
  setPlayingMediaPin,
  setRecent,
} = await import('../src/shared/storage');

let nextTab = 8_000;

function efg(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function video(asset: string): MediaItem {
  return {
    id: `video-${asset}`,
    url: `https://video.xx.fbcdn.net/v/t42/${asset}.mp4?efg=${efg({ xpv_asset_id: asset })}`,
    kind: 'video',
    source: 'story',
    origin: 'graphql',
    addedAt: 1_800_000_000_000,
  };
}

function quotaError(): Error {
  const error = new Error('QUOTA_BYTES quota exceeded');
  error.name = 'QuotaExceededError';
  return error;
}

function storyDataId(storyId: string): string {
  return Buffer.from(`S:_ISC:${storyId}`).toString('base64');
}

beforeEach(resetChromeStorage);

test('setPlaying retries a one-shot backend failure and reports a durable acknowledgement', async () => {
  const tabId = nextTab++;
  const ref = { ids: ['active'], hasVideo: true, mark: 'vm:active', at: 1_800_000_001_000 };
  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  let attempts = 0;
  session.set = async (values): Promise<void> => {
    if (`playing_${tabId}` in values && attempts++ === 0) throw new TypeError('transient storage backend failure');
    await realSet(values);
  };

  try {
    assert.equal(await setPlaying(tabId, ref), true);
  } finally {
    session.set = realSet;
  }

  assert.equal(attempts, 2);
  assert.deepEqual(await getPlaying(tabId), ref);
});

test('setRecent retries a one-shot backend failure instead of losing the only track anchor', async () => {
  const tabId = nextTab++;
  const url = 'https://video.xx.fbcdn.net/v/t42/current.mp4?bytestart=0&byteend=999';
  const at = 1_800_000_002_000;
  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  let attempts = 0;
  session.set = async (values): Promise<void> => {
    if (`recent_${tabId}` in values && attempts++ === 0) throw new TypeError('transient storage backend failure');
    await realSet(values);
  };

  try {
    assert.equal(await setRecent(tabId, url, at), true);
  } finally {
    session.set = realSet;
  }

  assert.equal(attempts, 2);
  assert.deepEqual((await getRecent(tabId))?.tracks, [{ url, at }]);
});

test('addSaved retries a transient failure without dropping download history', async () => {
  const tabId = nextTab++;
  for (let index = 0; index < 4; index++) {
    await addSaved(tabId, {
      id: `v:stored-${index}`,
      kind: 'video',
      source: 'story',
      savedAt: 1_800_000_002_100 + index,
    });
  }

  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  let attempts = 0;
  session.set = async (values): Promise<void> => {
    if (`saved_${tabId}` in values && attempts++ === 0) throw new TypeError('transient saved backend failure');
    await realSet(values);
  };

  try {
    await addSaved(tabId, {
      id: 'v:incoming',
      kind: 'video',
      source: 'story',
      savedAt: 1_800_000_002_200,
    });
  } finally {
    session.set = realSet;
  }

  assert.equal(attempts, 2);
  assert.deepEqual((await getSaved(tabId)).map((entry) => entry.id), [
    'v:stored-0',
    'v:stored-1',
    'v:stored-2',
    'v:stored-3',
    'v:incoming',
  ]);
});

test('rejects an oversized recent URL before it can consume shared control headroom', async () => {
  const tabId = nextTab++;
  const oversized = `https://video.xx.fbcdn.net/v/t42/track.mp4?token=${'x'.repeat(8_192)}`;

  assert.equal(classifyNetworkRequest(oversized, 1_800_000_002_300), null);
  assert.equal(await setRecent(tabId, oversized, 1_800_000_002_300), false);
  assert.equal(await getRecent(tabId), null);
  assert.equal(await addMedia(tabId, [{ ...video('oversized'), url: oversized }]), 0);
  assert.deepEqual(await getMedia(tabId), []);
});

test('retrying an already-persisted recent observation is idempotent', async () => {
  const tabId = nextTab++;
  const url = 'https://video.xx.fbcdn.net/v/t42/idempotent.mp4?bytestart=0&byteend=999';
  const at = 1_800_000_002_500;
  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  let failures = 0;
  session.set = async (values): Promise<void> => {
    await realSet(values);
    if (`recent_${tabId}` in values && failures++ < 2) throw new TypeError('ack lost after persistence');
  };

  try {
    assert.equal(await setRecent(tabId, url, at), false);
  } finally {
    session.set = realSet;
  }
  assert.equal(await setRecent(tabId, url, at), true);

  assert.deepEqual((await getRecent(tabId))?.tracks, [{ url, at }]);
});

test('the addMedia quota retry never replaces the sole protected capture with an empty Library', async () => {
  const tabId = nextTab++;
  const active = video('sole-active');
  await setPlaying(tabId, { ids: [active.id], hasVideo: true, at: 1_800_000_003_000 });

  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  let mediaAttempts = 0;
  session.set = async (values): Promise<void> => {
    if (`media_${tabId}` in values && mediaAttempts++ === 0) throw quotaError();
    await realSet(values);
  };

  try {
    assert.equal(await addMedia(tabId, [active]), 1);
  } finally {
    session.set = realSet;
  }

  assert.equal(mediaAttempts, 2);
  assert.deepEqual((await getMedia(tabId)).map((item) => item.id), [active.id]);
});

test('addMedia reclaims shared quota globally while preserving another tab active row', async () => {
  const fullTab = nextTab++;
  const incomingTab = nextTab++;
  const oldest = { ...video('global-oldest'), addedAt: 1_800_000_000_001 };
  const ordinary = { ...video('global-ordinary'), addedAt: 1_800_000_000_002 };
  const active = { ...video('global-active'), addedAt: 1_800_000_000_003 };
  const incoming = { ...video('global-incoming'), addedAt: 1_800_000_000_004 };
  await addMedia(fullTab, [oldest, ordinary, active]);
  await setPlaying(fullTab, { ids: [active.id], hasVideo: true, at: 1_800_000_000_005 });

  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  let quotaFailures = 0;
  session.set = async (values): Promise<void> => {
    const payload = values as Record<string, unknown>;
    if (`media_${incomingTab}` in payload) {
      const projected = (`media_${fullTab}` in payload
        ? payload[`media_${fullTab}`]
        : (await session.get(`media_${fullTab}`))[`media_${fullTab}`]) as MediaItem[] | undefined;
      if ((projected?.length ?? 0) > 1) {
        quotaFailures++;
        throw quotaError();
      }
    }
    await realSet(values);
  };

  try {
    assert.equal(await addMedia(incomingTab, [incoming]), 1);
  } finally {
    session.set = realSet;
  }

  assert.ok(quotaFailures >= 2, 'direct and intact global retries should observe shared quota');
  assert.deepEqual((await getMedia(fullTab)).map((item) => item.id), [active.id]);
  assert.deepEqual((await getMedia(incomingTab)).map((item) => item.id), [incoming.id]);
});

test('addMedia rejects without corruption when global quota has no safe candidate', async () => {
  const protectedTab = nextTab++;
  const incomingTab = nextTab++;
  const active = video('global-only-active');
  const incoming = video('global-only-incoming');
  await addMedia(protectedTab, [active]);
  await setPlaying(protectedTab, { ids: [active.id], hasVideo: true, at: 1_800_000_000_010 });

  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  session.set = async (values): Promise<void> => {
    if (`media_${incomingTab}` in values) throw quotaError();
    await realSet(values);
  };

  try {
    await assert.rejects(addMedia(incomingTab, [incoming]), /no safe media rows/i);
  } finally {
    session.set = realSet;
  }

  assert.deepEqual((await getMedia(protectedTab)).map((item) => item.id), [active.id]);
  assert.deepEqual(await getMedia(incomingTab), []);
});

test('addMedia serializes media writes across tabs before taking a global snapshot', async () => {
  const firstTab = nextTab++;
  const secondTab = nextTab++;
  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  let releaseFirst!: () => void;
  let reportFirstEntered!: () => void;
  const firstEntered = new Promise<void>((resolve) => { reportFirstEntered = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let activeMediaWrites = 0;
  let maxActiveMediaWrites = 0;

  session.set = async (values): Promise<void> => {
    const isFirst = `media_${firstTab}` in values;
    const isSecond = `media_${secondTab}` in values;
    if (!isFirst && !isSecond) {
      await realSet(values);
      return;
    }
    activeMediaWrites++;
    maxActiveMediaWrites = Math.max(maxActiveMediaWrites, activeMediaWrites);
    try {
      if (isFirst) {
        reportFirstEntered();
        await firstGate;
      }
      await realSet(values);
    } finally {
      activeMediaWrites--;
    }
  };

  try {
    const first = addMedia(firstTab, [video('serialized-first')]);
    await firstEntered;
    const second = addMedia(secondTab, [video('serialized-second')]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(maxActiveMediaWrites, 1);
    releaseFirst();
    assert.deepEqual(await Promise.all([first, second]), [1, 1]);
  } finally {
    releaseFirst();
    session.set = realSet;
  }

  assert.equal(maxActiveMediaWrites, 1);
});

test('global reclaim waits for a foreign PlayingRef update before choosing eviction candidates', async () => {
  const watchedTab = nextTab++;
  const incomingTab = nextTab++;
  const inactive = { ...video('reclaim-race-inactive'), addedAt: 1_800_000_000_001 };
  const active = { ...video('reclaim-race-active'), addedAt: 1_800_000_000_002 };
  const incoming = { ...video('reclaim-race-incoming'), addedAt: 1_800_000_000_003 };
  await addMedia(watchedTab, [inactive, active]);

  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  let releasePlaying!: () => void;
  let reportPlayingEntered!: () => void;
  const playingEntered = new Promise<void>((resolve) => { reportPlayingEntered = resolve; });
  const playingGate = new Promise<void>((resolve) => { releasePlaying = resolve; });
  let mediaAttempts = 0;

  session.set = async (values): Promise<void> => {
    if (`playing_${watchedTab}` in values) {
      reportPlayingEntered();
      await playingGate;
      await realSet(values);
      return;
    }
    if (`media_${incomingTab}` in values) {
      mediaAttempts++;
      const payload = values as Record<string, unknown>;
      const projected = (`media_${watchedTab}` in payload
        ? payload[`media_${watchedTab}`]
        : (await session.get(`media_${watchedTab}`))[`media_${watchedTab}`]) as MediaItem[] | undefined;
      if ((projected?.length ?? 0) > 1) throw quotaError();
    }
    await realSet(values);
  };

  try {
    const playingWrite = setPlaying(watchedTab, {
      ids: [active.id],
      hasVideo: true,
      at: 1_800_000_000_004,
    });
    await playingEntered;
    const mediaWrite = addMedia(incomingTab, [incoming]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The direct media write may fail, but quota reclaim must wait until the
    // foreign PlayingRef is durable before it snapshots/classifies that tab.
    assert.equal(mediaAttempts, 1);
    releasePlaying();
    assert.equal(await playingWrite, true);
    assert.equal(await mediaWrite, 1);
  } finally {
    releasePlaying();
    session.set = realSet;
  }

  assert.deepEqual((await getMedia(watchedTab)).map((item) => item.id), [active.id]);
  assert.deepEqual((await getMedia(incomingTab)).map((item) => item.id), [incoming.id]);
});

test('a pin quota failure spends headroom without evicting unrelated Library media', async () => {
  const tabId = nextTab++;
  const active = video('pin-active');
  const unrelated = video('pin-unrelated');
  await addMedia(tabId, [unrelated, active]);
  const mark = storyCardMark('/stories/owner/url-card/', storyDataId('980000000008001'));
  const playingAt = 1_800_000_004_000;
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${mark}#vm:1`, at: playingAt });
  const identity = playingRetentionIdentity(await getPlaying(tabId));
  assert.ok(identity);

  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  let pinAttempts = 0;
  session.set = async (values): Promise<void> => {
    if (`playing_pin_${tabId}` in values && pinAttempts++ === 0) throw quotaError();
    await realSet(values);
  };

  try {
    assert.equal(await setPlayingMediaPin(tabId, identity, [videoGroupKey(active)], playingAt), true);
  } finally {
    session.set = realSet;
  }

  const storedPin = (await chrome.storage.session.get(`playing_pin_${tabId}`))[`playing_pin_${tabId}`] as {
    groups?: string[];
  };
  assert.equal(pinAttempts, 2);
  assert.deepEqual(storedPin.groups, [videoGroupKey(active)]);
  assert.deepEqual((await getMedia(tabId)).map((item) => item.id), [unrelated.id, active.id]);
});

test('control headroom initialization is idempotent across worker restarts', async () => {
  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  let reserveWrites = 0;
  session.set = async (values): Promise<void> => {
    if ('capture_control_headroom_v1' in values) reserveWrites++;
    await realSet(values);
  };

  try {
    assert.equal(await ensureCaptureHeadroom(), true);
    assert.equal(await ensureCaptureHeadroom(), true);
  } finally {
    session.set = realSet;
  }

  assert.equal(reserveWrites, 1);
});

test('a transient headroom read failure cannot poison worker capture readiness', async () => {
  const session = chrome.storage.session;
  const originalGet = session.get;
  const realGet = originalGet.bind(session) as unknown as (
    key: string | string[] | null,
  ) => Promise<Record<string, unknown>>;
  const realWarn = console.warn;
  let failedRead = false;
  session.get = (async (key: unknown): Promise<Record<string, unknown>> => {
    if (key === 'capture_control_headroom_v1' && !failedRead) {
      failedRead = true;
      throw new TypeError('temporary session.get failure');
    }
    return realGet(key as string | string[] | null);
  }) as typeof session.get;
  console.warn = () => {};

  try {
    assert.equal(await ensureCaptureHeadroom(), true);
  } finally {
    session.get = originalGet;
    console.warn = realWarn;
  }

  const reserve = (await session.get('capture_control_headroom_v1')).capture_control_headroom_v1;
  assert.equal(failedRead, true);
  assert.equal(typeof reserve, 'string');
  assert.ok((reserve as string).length >= 128 * 1024);
});

test('persistent shared quota establishes a new unbound PlayingRef without deleting its sole Library candidate', async () => {
  const tabId = nextTab++;
  const candidate = video('headroom-unbound-active');
  await ensureCaptureHeadroom();
  await addMedia(tabId, [candidate]);
  await setPlaying(tabId, { ids: ['old'], hasVideo: true, mark: 'vm:old', at: 1_800_000_004_500 });
  const mark = storyCardMark('/stories/owner/url-card/', storyDataId('980000000008101'));
  const next = { ids: [], hasVideo: true, mark: `${mark}#vm:new`, at: 1_800_000_004_600 };

  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  let quotaFailures = 0;
  session.set = async (values): Promise<void> => {
    const payload = values as Record<string, unknown>;
    if (`playing_${tabId}` in values && payload.capture_control_headroom_v1 !== '') {
      quotaFailures++;
      throw quotaError();
    }
    await realSet(values);
  };

  try {
    assert.equal(await setPlaying(tabId, next), true);
  } finally {
    session.set = realSet;
  }

  assert.equal(quotaFailures, 1);
  assert.deepEqual(await getPlaying(tabId), next);
  assert.deepEqual((await getMedia(tabId)).map((item) => item.id), [candidate.id]);
  const reserve = (await chrome.storage.session.get('capture_control_headroom_v1')).capture_control_headroom_v1;
  assert.equal(typeof reserve === 'string' && reserve.length >= 128 * 1024, true);
});

test('simultaneous quota recovery in two tabs serializes shared headroom', async () => {
  const firstTab = nextTab++;
  const secondTab = nextTab++;
  await ensureCaptureHeadroom();
  await setPlaying(firstTab, { ids: ['old-a'], hasVideo: true, at: 1_800_000_004_700 });
  await setPlaying(secondTab, { ids: ['old-b'], hasVideo: true, at: 1_800_000_004_700 });
  const first = { ids: ['new-a'], hasVideo: true, at: 1_800_000_004_800 };
  const second = { ids: ['new-b'], hasVideo: true, at: 1_800_000_004_800 };

  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  let quotaFailures = 0;
  session.set = async (values): Promise<void> => {
    const payload = values as Record<string, unknown>;
    const isPlayingWrite = `playing_${firstTab}` in values || `playing_${secondTab}` in values;
    if (isPlayingWrite && payload.capture_control_headroom_v1 !== '') {
      quotaFailures++;
      throw quotaError();
    }
    await realSet(values);
  };

  try {
    assert.deepEqual(await Promise.all([setPlaying(firstTab, first), setPlaying(secondTab, second)]), [true, true]);
  } finally {
    session.set = realSet;
  }

  assert.equal(quotaFailures, 2);
  assert.deepEqual(await getPlaying(firstTab), first);
  assert.deepEqual(await getPlaying(secondTab), second);
});

test('clearTab leaves shared control headroom available for the next tab', async () => {
  const tabId = nextTab++;
  await ensureCaptureHeadroom();
  await setPlaying(tabId, { ids: ['active'], hasVideo: true, at: 1_800_000_004_900 });

  await clearTab(tabId);

  const reserve = (await chrome.storage.session.get('capture_control_headroom_v1')).capture_control_headroom_v1;
  assert.equal(typeof reserve === 'string' && reserve.length >= 128 * 1024, true);
});

test('a playing quota recovery preserves the newly identified active capture', async () => {
  const tabId = nextTab++;
  const unrelated = video('playing-unrelated');
  const active = video('playing-active');
  await addMedia(tabId, [unrelated, active]);
  const ref = { ids: [active.id], hasVideo: true, mark: 'vm:current', at: 1_800_000_005_000 };

  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  let playingAttempts = 0;
  session.set = async (values): Promise<void> => {
    if (`playing_${tabId}` in values && playingAttempts++ === 0) throw quotaError();
    await realSet(values);
  };

  try {
    assert.equal(await setPlaying(tabId, ref), true);
  } finally {
    session.set = realSet;
  }

  assert.equal(playingAttempts, 2);
  assert.deepEqual(await getPlaying(tabId), ref);
  assert.equal((await getMedia(tabId)).some((item) => item.id === active.id), true);
});

test('a failed pin quota recovery never deletes the sole protected capture', async () => {
  const tabId = nextTab++;
  const active = video('only-pin-active');
  await addMedia(tabId, [active]);
  const mark = storyCardMark('/stories/owner/url-card/', storyDataId('980000000008002'));
  const playingAt = 1_800_000_006_000;
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${mark}#vm:1`, at: playingAt });
  const identity = playingRetentionIdentity(await getPlaying(tabId));
  assert.ok(identity);

  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  session.set = async (values): Promise<void> => {
    if (`playing_pin_${tabId}` in values) throw quotaError();
    await realSet(values);
  };

  try {
    assert.equal(await setPlayingMediaPin(tabId, identity, [videoGroupKey(active)], playingAt), false);
  } finally {
    session.set = realSet;
  }

  assert.deepEqual((await getMedia(tabId)).map((item) => item.id), [active.id]);
});
