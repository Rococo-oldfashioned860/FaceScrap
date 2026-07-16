// FaceScrap side panel. Unlike a popup, it stays open while you browse and play
// videos, so it tracks the active tab of its window live and re-renders as
// media is captured (chrome.storage.session changes) or the tab switches.

import {
  isFbcdn,
  makeItem,
  mediaId,
  resolutionOf,
  videoGroupKey,
  type MediaItem,
  type MediaKind,
  type MediaSource,
} from '../shared/media';
import { getLang, setLang, t, type Lang, type MsgKey } from '../shared/i18n';
import { withTimeout } from '../shared/async';
import { getCaps, getMedia } from '../shared/storage';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from '../shared/settings';
import type { ClearTabMsg, DownloadDashMsg, DownloadDashResponse } from '../shared/messages';
import {
  flushBindingsNow,
  forgetLastLive,
  getGroupCover,
  loadBindings,
  purgeTabBindings,
  selectPlaying,
} from '../shared/now-playing';

type Filter = 'playing' | 'all' | MediaKind;

// User settings (loaded at startup, updated by the settings sheet). Behaviour reads
// this synchronously; the sheet writes it through applySetting() → saveSettings().
let settings: Settings = { ...DEFAULT_SETTINGS };

const SOURCE_KEY: Record<MediaSource, MsgKey> = {
  reel: 'sourceReel',
  story: 'sourceStory',
  highlight: 'sourceHighlight',
  video: 'sourceVideo',
  page: 'sourcePage',
};

const KIND_ICON: Record<MediaKind, string> = { video: '🎬', image: '🖼️', audio: '🎵' };

const KIND_KEY: Record<MediaKind, MsgKey> = {
  video: 'kindVideo',
  image: 'kindImage',
  audio: 'kindAudio',
};

let currentFilter: Filter = 'playing';
let tabId: number | undefined;
let windowId: number | undefined;

// DASH remux state keyed by item.id, so the download button's disabled/"Merging…"
// text survives the frequent full re-renders (every storage change + the 2s
// now-playing tick) instead of being rebuilt as a fresh, clickable button mid-job.
const downloading = new Set<string>();
const lastFailed = new Set<string>();
// Cover (poster) downloads in flight, keyed by thumbUrl. Like `downloading`, kept
// outside the DOM node so the busy state survives the frequent full re-renders: a
// re-render mid-download would otherwise rebuild an enabled button and a second
// click would start a duplicate download.
const coverDownloading = new Set<string>();
// False only on a Chromium browser without the offscreen API: DASH remux ("download
// with audio") is then impossible, so those options degrade to a direct video-only
// download. Defaults true; corrected once the SW's caps flag is read at startup.
let offscreenAvailable = true;
// Chosen quality per video (videoGroupKey → selected item.id), so a re-render
// (every storage change + the 2s now-playing tick) doesn't reset it to the best.
const qualityChoice = new Map<string, string>();

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

/** Resolve the active tab of the window this panel is docked in. */
async function resolveActiveTab(): Promise<void> {
  const win = await chrome.windows.getCurrent();
  windowId = win.id;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  tabId = tab?.id;
}

const LANG_KEY = 'lang';

async function loadLang(): Promise<Lang> {
  const stored = (await chrome.storage.local.get(LANG_KEY))[LANG_KEY];
  return stored === 'es' ? 'es' : 'en';
}

async function saveLang(lang: Lang): Promise<void> {
  await chrome.storage.local.set({ [LANG_KEY]: lang });
}

/** The language to use: the browser's when "follow browser language" is on,
 *  otherwise the manually-saved choice. */
async function resolveLang(): Promise<Lang> {
  if (settings.followBrowserLang) {
    return (navigator.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en';
  }
  return loadLang();
}

/** Localize every static [data-i18n]/[data-i18n-title] node and reflect the
 *  active language on the toggle. Dynamic rows are (re)built by render(). */
function localize(): void {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n as MsgKey | undefined;
    if (key) el.textContent = t(key);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    const key = el.dataset.i18nTitle as MsgKey | undefined;
    if (key) el.title = t(key);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => {
    const key = el.dataset.i18nAria as MsgKey | undefined;
    if (key) el.setAttribute('aria-label', t(key));
  });
  document.querySelectorAll<HTMLButtonElement>('#lang [data-lang]').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.lang === getLang());
  });
  // Keep the document language in sync so screen readers announce in the right one.
  document.documentElement.lang = getLang();
}

function setupLangToggle(): void {
  byId('lang').addEventListener('click', (e) => {
    if (settings.followBrowserLang) return; // manual toggle inert while following the browser
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-lang]');
    if (!btn) return;
    const lang: Lang = btn.dataset.lang === 'es' ? 'es' : 'en';
    if (lang === getLang()) return;
    setLang(lang);
    void saveLang(lang);
    localize();
    void render();
  });
}

/** Push the current settings into the sheet's controls. */
function reflectSettings(): void {
  byId<HTMLInputElement>('set-template').value = settings.filenameTemplate;
  byId<HTMLInputElement>('set-subfolder').checked = settings.subfolder;
  byId<HTMLSelectElement>('set-quality').value = settings.defaultQuality;
  byId<HTMLInputElement>('set-direct').checked = settings.directDownload;
  byId<HTMLInputElement>('set-followlang').checked = settings.followBrowserLang;
  byId<HTMLSelectElement>('set-order').value = settings.listOrder;
  byId<HTMLInputElement>('set-confirmclear').checked = settings.confirmClear;
  byId<HTMLInputElement>('set-videosonly').checked = settings.videosOnly;
  byId<HTMLSelectElement>('set-minres').value = String(settings.minResolution);
  byId<HTMLSelectElement>('set-maxitems').value = String(settings.maxItems);
  // The manual EN/ES toggle is inert while the language follows the browser.
  byId('lang').classList.toggle('is-disabled', settings.followBrowserLang);
}

/** Persist one setting, then re-apply anything it affects (language + re-render). */
async function applySetting(patch: Partial<Settings>): Promise<void> {
  settings = { ...settings, ...patch };
  await saveSettings(patch);
  if ('followBrowserLang' in patch) {
    setLang(await resolveLang());
    localize();
  }
  reflectSettings();
  lastRenderSig = ''; // settings feed the render; force the skipped-if-unchanged rebuild
  await render();
}

/** Open/close the settings sheet and wire every control to applySetting(). */
function setupSettings(): void {
  const sheet = byId('settings');
  const setOpen = (open: boolean): void => {
    sheet.hidden = !open;
  };
  byId('settings-open').addEventListener('click', () => setOpen(true));
  byId('settings-close').addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sheet.hidden) setOpen(false);
  });

  const onCheck = (id: string, key: keyof Settings): void => {
    byId<HTMLInputElement>(id).addEventListener('change', (e) => {
      void applySetting({ [key]: (e.target as HTMLInputElement).checked } as Partial<Settings>);
    });
  };
  const onSelect = (id: string, apply: (v: string) => Partial<Settings>): void => {
    byId<HTMLSelectElement>(id).addEventListener('change', (e) => {
      void applySetting(apply((e.target as HTMLSelectElement).value));
    });
  };

  byId<HTMLInputElement>('set-template').addEventListener('change', (e) => {
    void applySetting({ filenameTemplate: (e.target as HTMLInputElement).value });
  });
  onCheck('set-subfolder', 'subfolder');
  onSelect('set-quality', (v) => ({ defaultQuality: v as Settings['defaultQuality'] }));
  onCheck('set-direct', 'directDownload');
  onCheck('set-followlang', 'followBrowserLang');
  onSelect('set-order', (v) => ({ listOrder: v as Settings['listOrder'] }));
  onCheck('set-confirmclear', 'confirmClear');
  onCheck('set-videosonly', 'videosOnly');
  onSelect('set-minres', (v) => ({ minResolution: Number(v) }));
  onSelect('set-maxitems', (v) => ({ maxItems: Number(v) }));

  reflectSettings();
}

function isDownloadable(item: MediaItem): boolean {
  // Only fbcdn media is downloadable — never a URL that slipped in from the page.
  return isFbcdn(item.url);
}

function extFor(kind: MediaKind): string {
  return kind === 'image' ? 'jpg' : kind === 'audio' ? 'm4a' : 'mp4';
}

/** Seconds → "M:SS" (or "H:MM:SS" past an hour). */
function formatDuration(sec: number): string {
  const s = Math.round(sec);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** Bitrate (bytes/s) parsed from a fbcdn URL's `bitrate=` param, 0 if absent. */
function bitrate(url: string): number {
  const m = url.match(/[?&]bitrate=(\d+)/);
  return m ? Number(m[1]) : 0;
}

function filenameFor(item: MediaItem): string {
  const stamp = new Date(item.addedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const id = item.id.replace(/[^a-z0-9]/gi, '').slice(-8) || 'file';
  const base = (settings.filenameTemplate || DEFAULT_SETTINGS.filenameTemplate)
    .replace(/\{source\}/g, item.source)
    .replace(/\{date\}/g, stamp)
    .replace(/\{id\}/g, id)
    // Collapse anything not filename-safe: blocks path traversal (../), CRLF, and
    // reserved characters, so a template can't escape the download directory.
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120) || 'facescrap';
  const name = `${base}.${extFor(item.kind)}`;
  return settings.subfolder ? `FaceScrap/${name}` : name;
}

/** Whether downloads should open the browser's Save-As dialog (quality = 'ask'). */
function askOnSave(): boolean {
  return settings.defaultQuality === 'ask';
}

async function download(item: MediaItem): Promise<void> {
  await chrome.downloads.download({
    url: item.url,
    filename: filenameFor(item),
    conflictAction: 'uniquify',
    saveAs: askOnSave(),
  });
}

function warnTag(text: string): HTMLElement {
  const s = document.createElement('span');
  s.className = 'tag tag-warn';
  s.textContent = text;
  return s;
}

/** Remux DASH pair via the offscreen doc. Tracks in-flight by item.id (survives
 *  re-render) and re-renders on settle. The SW dedups by track pair. */
function startDashDownload(item: MediaItem): void {
  const audioUrl = item.audioUrl;
  if (audioUrl == null) return; // callers gate on audioUrl; narrow it for the typed message
  downloading.add(item.id);
  lastFailed.delete(item.id);
  void render();
  withTimeout(
    chrome.runtime.sendMessage({
      type: 'FACESCRAP_DOWNLOAD_DASH',
      videoUrl: item.url,
      audioUrl,
      filename: filenameFor(item),
      saveAs: askOnSave(),
    } satisfies DownloadDashMsg),
    120000,
    'The merge timed out.',
  )
    .then((r: DownloadDashResponse | undefined) => {
      if (!r?.ok) throw new Error(r?.error || 'Merge failed.');
    })
    .catch((e: unknown) => {
      lastFailed.add(item.id);
      console.error('[FaceScrap]', e);
    })
    .finally(() => {
      downloading.delete(item.id);
      void render();
    });
}

/** Direct download of a progressive/complete media URL (already has audio).
 *  Busy state lives in the shared `downloading` set (not just the DOM node), so
 *  it survives the re-renders that replace the button mid-download. */
function startDirectDownload(item: MediaItem, btn: HTMLButtonElement): void {
  downloading.add(item.id);
  btn.disabled = true;
  btn.textContent = t('saving');
  void download(item)
    .catch((e) => console.error('[FaceScrap]', e))
    .finally(() => {
      downloading.delete(item.id);
      btn.textContent = t('download');
      btn.disabled = false;
      void render();
    });
}

/** Download just a video's poster/cover image (its thumbUrl), as a standalone
 *  JPG — no need to grab the whole clip. Built as a throwaway image item so it
 *  reuses the normal download path (filename, fbcdn guard). */
function startCoverDownload(thumbUrl: string, source: MediaSource, btn: HTMLButtonElement): void {
  if (!isFbcdn(thumbUrl)) return;
  if (coverDownloading.has(thumbUrl)) return; // already saving this cover
  const cover = makeItem(thumbUrl, 'image', source, 'graphql', Date.now());
  coverDownloading.add(thumbUrl);
  btn.disabled = true;
  void download(cover)
    .catch((e) => console.error('[FaceScrap] cover download', e))
    .finally(() => {
      coverDownloading.delete(thumbUrl);
      btn.disabled = false;
      // Re-render so a button rebuilt (and left disabled) mid-download re-enables.
      void render();
    });
}

/** Row for a non-video item (image/audio). Videos always render through
 *  renderVideoGroup — render() splits them off before reaching here. */
function renderItem(item: MediaItem): HTMLElement {
  const row = document.createElement('div');
  row.className = 'item';

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  // Images preview themselves; audio has no preview and falls to the icon.
  const thumbSrc = item.kind === 'image' ? item.url : item.thumbUrl;
  if (thumbSrc) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    // fbcdn URL expired/blocked → fall back to the emoji icon.
    img.addEventListener('error', () => {
      img.remove();
      thumb.textContent = KIND_ICON[item.kind];
    });
    img.src = thumbSrc;
    thumb.appendChild(img);
  } else {
    thumb.textContent = KIND_ICON[item.kind];
  }

  const meta = document.createElement('div');
  meta.className = 'meta';

  const kind = document.createElement('div');
  kind.className = 'kind';
  kind.textContent = `${t(SOURCE_KEY[item.source])} · ${t(KIND_KEY[item.kind])}`;
  if (item.kind === 'audio') kind.appendChild(warnTag(t('tagAudioTrack')));

  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = new URL(item.url).hostname;

  meta.append(kind, sub);

  const btn = document.createElement('button');
  btn.className = 'dl';
  if (isDownloadable(item)) {
    const busy = downloading.has(item.id);
    btn.textContent = busy ? t('saving') : t('download');
    btn.disabled = busy;
    btn.addEventListener('click', () => startDirectDownload(item, btn));
  } else {
    btn.textContent = t('unavailable');
    btn.disabled = true;
    btn.title = t('titleBlobUnavailable');
  }

  row.append(thumb, meta, btn);
  return row;
}

/** One row for a video, collapsing its representations into a quality picker. */
function renderVideoGroup(group: MediaItem[], tid: number | undefined): HTMLElement {
  // Strip the audio track from DASH pairs (→ direct video-only download) when the
  // offscreen API is unavailable (no way to remux) OR the user chose "direct
  // download" in settings. Everything below already handles audio-less items —
  // they pick up the existing "may lack audio" warning.
  const stripAudio = !offscreenAvailable || settings.directDownload;
  const src = stripAudio ? group.map((i) => (i.audioUrl != null ? { ...i, audioUrl: undefined } : i)) : group;
  // Downloadable options: any fbcdn representation — including the network
  // capture, the always-present baseline. Deduplicated by resolution: for each
  // height we prefer the one that will produce sound
  // (muxed progressive or DASH pair with audioUrl) over a muted DASH track of the
  // same size.
  const downloadable = src.filter(isDownloadable);
  // Will the download have sound? audioUrl → gets remuxed; non-`dash` → muxed
  // progressive; a `dash` track without audioUrl is video-only (muted).
  const willHaveAudio = (i: MediaItem): boolean => i.audioUrl != null || !i.dash;
  // Muxed progressive (has sound + direct download) > DASH pair (has sound,
  // requires merging) > muted track; ties broken by higher bitrate.
  const score = (i: MediaItem): number => (willHaveAudio(i) ? 2 : 0) + (i.audioUrl == null ? 1 : 0);
  const byRes = new Map<string, MediaItem>();
  for (const i of downloadable) {
    const { label } = resolutionOf(i);
    if (label === 'Video') {
      byRes.set(`Video:${i.id}`, i); // unknown: don't collapse
      continue;
    }
    const prev = byRes.get(label);
    if (!prev) {
      byRes.set(label, i);
      continue;
    }
    const ds = score(i) - score(prev);
    if (ds > 0 || (ds === 0 && bitrate(i.url) > bitrate(prev.url))) byRes.set(label, i);
  }
  const options = [...byRes.values()].sort(
    (a, b) => resolutionOf(b).rank - resolutionOf(a).rank || bitrate(b.url) - bitrate(a.url),
  );
  const gkey = videoGroupKey(src[0]);
  // Captured poster first; else the on-screen cover learned while it played.
  const thumbUrl =
    src.find((i) => i.thumbUrl != null)?.thumbUrl ??
    (tid !== undefined ? getGroupCover(tid, gkey) : undefined);
  const source = src[0].source;

  const row = document.createElement('div');
  row.className = 'item';

  const thumb = document.createElement('div');
  thumb.className = 'thumb is-video';
  if (thumbUrl) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    const cover = document.createElement('button');
    img.addEventListener('error', () => {
      img.remove();
      cover.remove();
      thumb.classList.remove('is-video');
      thumb.textContent = KIND_ICON.video;
    });
    img.src = thumbUrl;
    thumb.appendChild(img);
    // Save-cover affordance: grab only the poster image, without the video.
    cover.className = 'cover-dl';
    cover.type = 'button';
    cover.textContent = '⤓';
    cover.title = t('saveCover');
    cover.setAttribute('aria-label', t('saveCover'));
    cover.disabled = coverDownloading.has(thumbUrl); // survive a rebuild mid-download
    cover.addEventListener('click', () => startCoverDownload(thumbUrl, source, cover));
    thumb.appendChild(cover);
  } else {
    thumb.classList.remove('is-video');
    thumb.textContent = KIND_ICON.video;
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  const kind = document.createElement('div');
  kind.className = 'kind';
  kind.textContent = `${t(SOURCE_KEY[source])} · ${t('kindVideo')}`;
  const durationSec = src.find((i) => i.durationSec != null)?.durationSec;
  if (durationSec != null) {
    const dur = document.createElement('span');
    dur.className = 'dur';
    dur.textContent = formatDuration(durationSec);
    kind.appendChild(dur);
  }
  const sub = document.createElement('div');
  sub.className = 'sub';

  const btn = document.createElement('button');
  btn.className = 'dl';

  if (options.length === 0) {
    btn.textContent = t('unavailable');
    btn.disabled = true;
  } else {
    // options are sorted highest-resolution first; preselect per the quality setting
    // ('ask' still shows the highest, but the download opens the Save-As dialog).
    const fallback = settings.defaultQuality === 'lowest' ? options[options.length - 1] : options[0];
    let selected = options.find((o) => o.id === qualityChoice.get(gkey)) ?? fallback;
    // Warning shown when the chosen quality is a video-only DASH track (will download muted).
    const warn = warnTag(t('tagMayLackAudio'));
    kind.appendChild(warn);
    const paint = (): void => {
      warn.hidden = willHaveAudio(selected);
      const busy = downloading.has(selected.id);
      btn.disabled = busy;
      btn.textContent = busy
        ? selected.audioUrl != null
          ? t('merging')
          : t('saving')
        : lastFailed.has(selected.id)
          ? t('retry')
          : selected.audioUrl != null
            ? t('downloadWithAudio')
            : t('download');
    };

    if (options.length > 1) {
      const sel = document.createElement('select');
      sel.className = 'quality';
      for (const opt of options) {
        const o = document.createElement('option');
        o.value = opt.id;
        o.textContent = resolutionOf(opt).label;
        sel.appendChild(o);
      }
      sel.value = selected.id;
      sel.addEventListener('change', () => {
        selected = options.find((o) => o.id === sel.value) ?? options[0];
        qualityChoice.set(gkey, selected.id);
        paint();
      });
      sub.appendChild(sel);
    } else {
      sub.textContent = resolutionOf(selected).label;
    }

    btn.addEventListener('click', () => {
      if (selected.audioUrl != null) startDashDownload(selected);
      else startDirectDownload(selected, btn);
    });
    paint();
  }

  meta.append(kind, sub);
  row.append(thumb, meta, btn);
  return row;
}

// render() is invoked from overlapping async sources (storage events, the 2s
// tick, tab switches); serialize it so two in-flight renders can't append
// duplicate rows, and coalesce bursts into one trailing rerun.
let renderRunning = false;
let renderQueued = false;
let lastRenderSig = '';
let renderBlockedSince = 0;
let renderRetryTimer: ReturnType<typeof setTimeout> | undefined;

async function render(): Promise<void> {
  if (renderRunning) {
    renderQueued = true;
    return;
  }
  renderRunning = true;
  try {
    await doRender();
  } finally {
    renderRunning = false;
    if (renderQueued) {
      renderQueued = false;
      void render();
    }
  }
}

async function doRender(): Promise<void> {
  const list = byId('list');
  const empty = byId('empty');

  // Snapshot the tab once: doRender yields at every await, and onActivated can
  // flip module `tabId` mid-render — reading it twice would mix tab A's items
  // with tab B's now-playing. The queued rerun renders the newly-active tab.
  const tid = tabId;
  const items = tid === undefined ? [] : await getMedia(tid);
  const filtered =
    currentFilter === 'playing'
      ? tid === undefined
        ? []
        : await selectPlaying(tid, items)
      : items.filter((i) => currentFilter === 'all' || i.kind === currentFilter);
  // "Videos only" is a view filter (images/audio hidden, never dropped from storage).
  const visible = settings.videosOnly ? filtered.filter((i) => i.kind === 'video') : filtered;

  // Skip the DOM rebuild when nothing visible changed: tearing the list down
  // every ≤2s closes an open quality <select> under the cursor, drops keyboard
  // focus, and makes the aria-live region re-announce. The signature covers
  // everything a row renders from.
  const sig = [
    currentFilter,
    getLang(),
    String(offscreenAvailable),
    // Cover-download busy state isn't per stored item (the cover is a throwaway),
    // so it rides the top-level signature: a start/finish forces a rebuild that
    // reflects the button's disabled state.
    [...coverDownloading].sort().join(','),
    JSON.stringify([
      settings.listOrder,
      settings.videosOnly,
      settings.minResolution,
      settings.directDownload,
      settings.defaultQuality,
    ]),
    ...visible.map(
      // qualityChoice is deliberately NOT in the signature: picking a quality is
      // painted in place by the row's change handler, so forcing a rebuild for it
      // only tears down the focused/open <select> ~10s later (closing the dropdown,
      // dropping focus, re-announcing the aria-live list). A rebuild from any other
      // cause still reads qualityChoice when it repaints the row.
      (i) =>
        `${i.id}|${i.audioUrl ?? ''}|${i.thumbUrl ?? ''}|${i.height ?? ''}|${i.durationSec ?? ''}|${
          downloading.has(i.id) ? 1 : 0
        }|${lastFailed.has(i.id) ? 1 : 0}|${
          tid !== undefined ? (getGroupCover(tid, videoGroupKey(i)) ?? '') : ''
        }`,
    ),
  ].join('\n');
  if (sig === lastRenderSig) return;
  // Content DID change but the user is mid-pick in a quality dropdown — hold the
  // rebuild briefly; cap the hold so updates can't be blocked forever by a select
  // that keeps focus after closing.
  const ae = document.activeElement;
  if (ae instanceof HTMLSelectElement && list.contains(ae)) {
    if (renderBlockedSince === 0) renderBlockedSince = Date.now();
    if (Date.now() - renderBlockedSince < 10_000) {
      // Schedule our own retry: the 2s tick only re-renders in the 'playing'
      // filter, so in all/video/image a held update (a gained audioUrl, a new
      // capture) would sit stale on a quiet page until the user acts. One pending
      // timer, coalesced.
      if (renderRetryTimer === undefined) {
        renderRetryTimer = setTimeout(() => {
          renderRetryTimer = undefined;
          void render();
        }, 1000);
      }
      return;
    }
  }
  renderBlockedSince = 0;
  if (renderRetryTimer !== undefined) {
    clearTimeout(renderRetryTimer);
    renderRetryTimer = undefined;
  }
  lastRenderSig = sig;

  // Rows under "Now playing" are live captures — the blue ring marks them.
  list.classList.toggle('is-live', currentFilter === 'playing');
  list.textContent = '';

  // Group videos by asset (one row with a quality picker); images/audio pass
  // straight through renderItem.
  const groups = new Map<string, MediaItem[]>();
  const others: MediaItem[] = [];
  for (const it of visible) {
    if (it.kind === 'video') {
      const key = videoGroupKey(it);
      const g = groups.get(key);
      if (g) g.push(it);
      else groups.set(key, [it]);
    } else {
      others.push(it);
    }
  }

  const rows: { at: number; el: HTMLElement; thumbId?: string }[] = [];
  for (const group of groups.values()) {
    if (settings.minResolution > 0) {
      const maxH = Math.max(0, ...group.map((i) => i.height ?? 0));
      if (maxH > 0 && maxH < settings.minResolution) continue; // below the minimum-resolution filter
    }
    const at = Math.max(...group.map((i) => i.addedAt));
    const thumb = group.find((i) => i.thumbUrl != null)?.thumbUrl;
    rows.push({ at, el: renderVideoGroup(group, tid), thumbId: thumb ? mediaId(thumb) : undefined });
  }
  // Drop an image row that is only the cover of a shown video (avoid a dupe).
  const shownCovers = new Set(rows.map((r) => r.thumbId).filter(Boolean) as string[]);
  for (const it of others) {
    if (it.kind === 'image' && shownCovers.has(it.id)) continue;
    rows.push({ at: it.addedAt, el: renderItem(it) });
  }

  if (rows.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  rows.sort((a, b) => (settings.listOrder === 'oldest' ? a.at - b.at : b.at - a.at));
  for (const r of rows) list.appendChild(r.el);
}

function setupFilters(): void {
  byId('filters').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (!target.classList.contains('chip')) return;
    currentFilter = (target.dataset.filter as Filter) ?? 'all';
    byId('filters')
      .querySelectorAll('.chip')
      .forEach((c) => c.classList.toggle('is-active', c === target));
    void render();
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  await resolveActiveTab();
  // Restore learned bindings before the first render so a reopened panel can
  // re-match the current video without waiting for new fbcdn traffic.
  if (tabId !== undefined) await loadBindings(tabId);
  settings = await loadSettings();
  setLang(await resolveLang());
  const caps = await getCaps();
  offscreenAvailable = caps?.offscreen ?? true;
  byId('degraded').hidden = offscreenAvailable;
  setupFilters();
  setupLangToggle();
  setupSettings();
  localize();

  byId('clear').addEventListener('click', async () => {
    if (settings.confirmClear && !window.confirm(t('confirmClearPrompt'))) return;
    if (tabId !== undefined) {
      // Route through the worker so the wipe serializes on the same write chain as
      // capture writes (a panel-side clearTab can't, and the list would resurrect).
      // The worker also resets the badge once the removal lands.
      await chrome.runtime.sendMessage({ type: 'FACESCRAP_CLEAR_TAB', tabId } satisfies ClearTabMsg);
    }
    await render();
  });

  // New media captured (or cleared) for the tracked tab → re-render live. Only
  // keys for OUR tab matter — other tabs' churn must not force extra renders
  // (the signature skip makes them cheap, but not free).
  chrome.storage.session.onChanged.addListener((changes) => {
    if (tabId === undefined) return;
    const tid = tabId;
    // A nav/close reset (clearTab) removes media_/playing_/recent_/bind_ for the
    // tab (newValue undefined). The panel document survives an F5 of the page, so
    // treat that deletion as a hard reset: purge this tab's in-memory bindings +
    // last-live and cancel any pending flush, so a debounced write can't resurrect
    // bind_ after it was wiped and the panel stops showing the pre-reload video.
    const mediaCh = changes[`media_${tid}`];
    const playingCh = changes[`playing_${tid}`];
    if ((mediaCh && mediaCh.newValue === undefined) || (playingCh && playingCh.newValue === undefined)) {
      purgeTabBindings(tid);
    }
    if (
      `media_${tid}` in changes ||
      `playing_${tid}` in changes ||
      `recent_${tid}` in changes ||
      'caps' in changes
    ) {
      void render();
    }
  });

  // Forget the last-live video of tabs that close (panel-local memory).
  chrome.tabs.onRemoved.addListener((id) => {
    forgetLastLive(id);
  });

  // Keep language and settings in sync if another view (a second panel in another
  // window, or the popup) changes them — otherwise this panel's view and settings
  // sheet drift from the stored values until it is reopened.
  chrome.storage.local.onChanged.addListener((changes) => {
    const next = changes[LANG_KEY]?.newValue;
    if ((next === 'en' || next === 'es') && next !== getLang()) {
      setLang(next);
      localize();
      void render();
    }
    if ('settings' in changes) {
      // In the panel that made the change this is a cheap no-op: the values already
      // match, so reflectSettings is idempotent and render skips on an equal sig.
      void (async () => {
        settings = await loadSettings();
        reflectSettings();
        await render();
      })();
    }
  });

  // Follow the active tab within this window as the user switches tabs.
  chrome.tabs.onActivated.addListener(async (info) => {
    if (windowId !== undefined && info.windowId !== windowId) return;
    flushBindingsNow(); // persist the OUTGOING tab's learning before switching
    tabId = info.tabId;
    await loadBindings(info.tabId); // restore the incoming tab's bindings before its first render
    void render();
  });

  // Safety net: keep the "now playing" view fresh even if a storage event is missed.
  window.setInterval(() => {
    if (currentFilter === 'playing') void render();
  }, 2000);

  // Best-effort: persist learning captured within the 1s debounce window when the
  // panel is torn down (storage.session.set is async, so this is not guaranteed;
  // the 1s debounced flush covers the common case).
  window.addEventListener('pagehide', flushBindingsNow);

  await render();
});
