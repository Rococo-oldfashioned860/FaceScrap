// FaceScrap side panel. Unlike a popup, it stays open while you browse and play
// videos, so it tracks the active tab of its window live and re-renders as media
// is captured (chrome.storage.session changes) or the tab switches.
//
// Three top-level views — Now Playing / Library / Saved — plus a Settings overlay.
// Now Playing is the live video, in focus, with its own quality picker and one
// Download. Library and Saved share a card grid: per-card download, multi-select,
// a bulk tray.

import {
  isFbcdn,
  mediaId,
  resolutionOf,
  videoGroupKey,
  type MediaItem,
  type MediaKind,
  type MediaSource,
} from '../shared/media';
import { getLang, setLang, t, type Lang, type MsgKey } from '../shared/i18n';
import { withTimeout } from '../shared/async';
import { addSaved, getCaps, getMedia, getSaved, type SavedEntry } from '../shared/storage';
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

// Top-level view (the pill switch) and the Library/Saved sub-filter.
type View = 'now' | 'library' | 'saved';
type MediaFilter = 'all' | 'video' | 'image';

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

// Composition words for the tray's "video + image" line.
const COMPOSE_KEY: Record<MediaKind, MsgKey> = {
  video: 'composeVideo',
  image: 'composeImage',
  audio: 'composeAudio',
};

let view: View = 'now';
let mediaFilter: MediaFilter = 'all';
let tabId: number | undefined;
let windowId: number | undefined;

// Picked card ids (the tray cart). Kept outside the DOM so a pick survives the
// frequent full re-renders — every storage change plus the 2s tick rebuilds the
// grid, and a badge read back off the node would be lost.
const selected = new Set<string>();
// A single card/Now-Playing download in flight, keyed by card id, so its spinner
// and disabled state survive re-render.
const cardBusy = new Set<string>();
// A bulk (tray) run is in flight: render() must not paint over the button's
// progress label, and a second run must not start a parallel one. The guard is
// global because the offscreen document it drives is; `bulkTab` is only which
// tab's cart is being downloaded, which decides who owns the button's label.
let bulkRunning = false;
let bulkTab: number | undefined;
// Cards whose last download attempt failed, keyed by card id. There is no retry
// button in the grid, so this only puts an honest tag on the card; the Now Playing
// button turns into "Retry".
const lastFailed = new Set<string>();
// Tabs closed while this panel document lived. A download or bulk queue that
// snapshotted its tid keeps draining after the tab closes, and writing its
// receipts would recreate the saved_ key purgeTab just removed — the serial
// chain orders enqueued tasks, not future ones. Consulted before every addSaved.
const deadTabs = new Set<number>();
// Chosen quality per video (videoGroupKey → item id), so a re-render (every
// storage change + the 2s tick) doesn't reset the Now Playing selector to the best.
const qualityChoice = new Map<string, string>();
// False only on a Chromium browser without the offscreen API: DASH remux is then
// impossible, so those options degrade to a direct video-only download. Defaults
// true; corrected once the SW's caps flag is read at startup.
let offscreenAvailable = true;

/** A count string: `{n}` is substituted, and one is a different string entirely. */
function tn(one: MsgKey, many: MsgKey, n: number): string {
  return t(n === 1 ? one : many).replace('{n}', String(n));
}

/** "video + image" — only the kinds actually present, in a fixed order so the line
 *  doesn't reshuffle as items arrive. */
function composeLine(kinds: Iterable<MediaKind>): string {
  const present = new Set(kinds);
  return (['video', 'image', 'audio'] as const)
    .filter((k) => present.has(k))
    .map((k) => t(COMPOSE_KEY[k]))
    .join(' + ');
}

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

/** Localize every static [data-i18n]/[data-i18n-title]/[data-i18n-aria] node and
 *  reflect the active language on the toggle. Dynamic nodes are (re)built by render(). */
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
    lastRenderSig = '';
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

/** Open/close the settings overlay and wire every control to applySetting(). */
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

/** Append " · tag" to a card's meta line. The separator is the caller's because
 *  the meta line owns its own punctuation. */
function appendTag(meta: HTMLElement, text: string, cls?: string): void {
  const s = document.createElement('span');
  s.className = cls ? `tag ${cls}` : 'tag';
  s.textContent = text;
  meta.append(' · ', s);
}

/** DASH pairs lose their audio track — and with it the remux — when the browser
 *  can't remux at all, or the user asked for direct downloads. Everything
 *  downstream already handles audio-less items: they pick up the "may lack audio"
 *  tag. It is a setting, not a property of the item, so it has to be re-applied
 *  wherever a stored item is turned back into a download. */
function stripAudio(): boolean {
  return !offscreenAvailable || settings.directDownload;
}

/** Remux a DASH pair via the offscreen doc. The SW dedups by track pair. Resolves
 *  either way — a bulk run must survive one bad item — and reports whether it
 *  landed. Failure/saved bookkeeping is the caller's: it is keyed by CARD, and an
 *  item does not know which card is downloading it. */
async function startDashDownload(item: MediaItem): Promise<boolean> {
  const audioUrl = item.audioUrl;
  if (audioUrl == null) return false; // callers gate on audioUrl; narrow it for the typed message
  try {
    const r: DownloadDashResponse | undefined = await withTimeout(
      chrome.runtime.sendMessage({
        type: 'FACESCRAP_DOWNLOAD_DASH',
        videoUrl: item.url,
        audioUrl,
        filename: filenameFor(item),
        saveAs: askOnSave(),
      } satisfies DownloadDashMsg),
      120000,
      'The merge timed out.',
    );
    if (!r?.ok) throw new Error(r?.error || 'Merge failed.');
    return true;
  } catch (e: unknown) {
    console.error('[FaceScrap]', e);
    return false;
  }
}

/** Direct download of a progressive/complete media URL (already has audio).
 *  Resolves either way, for the same reason as startDashDownload. */
async function startDirectDownload(item: MediaItem): Promise<boolean> {
  try {
    await download(item);
    return true;
  } catch (e) {
    console.error('[FaceScrap]', e);
    return false;
  }
}

/** Freeze a download receipt at click time: the download can await up to 120s,
 *  during which a tab switch or navigation wipe may rebuild `cardsById` with
 *  other content — the receipt must describe what was actually saved. */
function savedEntryFor(cardId: string, item: MediaItem): SavedEntry {
  const card = cardsById.get(cardId);
  return {
    id: cardId,
    kind: item.kind,
    source: item.source,
    savedAt: Date.now(),
    thumbUrl: card?.thumbUrl ?? (item.kind === 'image' ? item.url : item.thumbUrl),
    resLabel: item.kind === 'video' ? resolutionOf(item).label : undefined,
    durationSec: card?.durationSec ?? item.durationSec,
  };
}

/** Download one item (a card's or Now Playing's chosen target). Sequential with
 *  the bulk run — both drive the single offscreen document — so it refuses to
 *  start while a bulk run is going, and the tray refuses to start while a single
 *  is going. Busy + failed state are keyed by card id and survive re-render. */
async function downloadCard(cardId: string, item: MediaItem): Promise<void> {
  if (bulkRunning || cardBusy.has(cardId)) return;
  // Snapshot the tab AND the receipt: the merge can await up to 120s, and
  // onActivated flips module `tabId` on a tab switch — the save belongs to the
  // tab and the card that were clicked.
  const tid = tabId;
  const receipt = savedEntryFor(cardId, item);
  cardBusy.add(cardId);
  lastFailed.delete(cardId);
  lastRenderSig = ''; // busy state feeds the card + the Now Playing button
  await render();
  const ok = item.audioUrl != null ? await startDashDownload(item) : await startDirectDownload(item);
  if (ok && tid !== undefined && !deadTabs.has(tid)) await addSaved(tid, [receipt]);
  // Panel-local bookkeeping belongs to the tab that started the download. If the
  // panel followed a tab switch during the (up to 120s) merge, onActivated has
  // already cleared cardBusy/lastFailed for the incoming tab — this run must not
  // re-seed them, or a failure would tag the wrong tab's card (fbcdn ids are
  // content-derived, so the same reel open in both tabs shares an id). Same guard
  // runBulk uses.
  if (tid === tabId) {
    cardBusy.delete(cardId);
    if (!ok) lastFailed.add(cardId);
    lastRenderSig = '';
    await render();
  }
}

// ── Card model (Library / Saved grid) ────────────────────────────────────────

/** One grid card: an image/audio item, or a whole video collapsed to the single
 *  representation the quality setting picks. */
interface Card {
  /** The card's identity in `selected`, `lastFailed`, `cardBusy` and the saved
   *  list. For a video this is the GROUP key, never `target.id`: which
   *  representation wins is recomputed every render, so it moves when a better one
   *  is captured or when the quality/direct-download settings flip — and a pick, a
   *  failure tag or a saved mark keyed to it would evaporate under a card still on
   *  screen. Prefixed because a group key and an item id are different namespaces
   *  that must never be able to collide. */
  id: string;
  /** Newest capture in the card, for the list order. */
  at: number;
  kind: MediaKind;
  source: MediaSource;
  /** Absent when nothing here is downloadable (an MSE blob:, a non-fbcdn URL). */
  target?: MediaItem;
  thumbUrl?: string;
  /** mediaId of thumbUrl — lets doRender drop an image card that is only a shown
   *  video's cover. */
  thumbId?: string;
  resLabel?: string;
  durationSec?: number;
  /** The target is a video-only DASH track: it will download muted. */
  mayLackAudio: boolean;
  /** This card is what the tab is playing right now. */
  live: boolean;
  /** Hidden from the LIBRARY grid by a declutter setting (videosOnly,
   *  minResolution) or the cover dedupe. A flag, not a drop: the Saved history
   *  and the cart must keep seeing the card. */
  libraryHidden?: boolean;
  /** A Saved receipt with no live capture behind it (media_ was wiped). Renders
   *  with honest disabled controls; revives when a replay re-captures the same
   *  content-derived id. */
  stale?: boolean;
}

/** Card-id scheme — a persisted format: saved_ receipts store these ids, so it
 *  changes only with a migration (see SavedEntry in storage.ts). Prefixed
 *  because group keys and item ids are namespaces that must never collide. */
const videoCardId = (gkey: string): string => `v:${gkey}`;
const itemCardId = (itemId: string): string => `i:${itemId}`;

/** Will the download have sound? audioUrl → gets remuxed; non-`dash` → muxed
 *  progressive; a `dash` track without audioUrl is video-only (muted). */
function willHaveAudio(i: MediaItem): boolean {
  return i.audioUrl != null || !i.dash;
}

interface VideoOptions {
  options: MediaItem[]; // downloadable representations, highest-resolution first
  gkey: string;
  thumbUrl?: string;
  durationSec?: number;
}

/** Collapse a video group's representations into a deduped, ranked option list —
 *  shared by the grid card (which takes one) and Now Playing (which keeps them all
 *  for the quality selector). */
function videoOptions(group: MediaItem[], tid: number | undefined): VideoOptions {
  const src = stripAudio()
    ? group.map((i) => (i.audioUrl != null ? { ...i, audioUrl: undefined } : i))
    : group;
  // Downloadable options: any fbcdn representation — including the network
  // capture, the always-present baseline. Deduplicated by resolution: for each
  // height prefer the one that will produce sound (muxed progressive or DASH pair
  // with audioUrl) over a muted DASH track of the same size.
  const downloadable = src.filter(isDownloadable);
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
  return {
    options,
    gkey,
    // Captured poster first; else the on-screen cover learned while it played.
    thumbUrl:
      src.find((i) => i.thumbUrl != null)?.thumbUrl ??
      (tid !== undefined ? getGroupCover(tid, gkey) : undefined),
    durationSec: src.find((i) => i.durationSec != null)?.durationSec,
  };
}

/** The setting's preselected representation from an option list: 'highest' takes
 *  the top, 'lowest' the bottom, 'ask' the top (it only opens the Save-As dialog). */
function defaultTarget(options: MediaItem[]): MediaItem | undefined {
  return settings.defaultQuality === 'lowest' ? options[options.length - 1] : options[0];
}

function buildVideoCard(group: MediaItem[], tid: number | undefined, playing: Set<string>): Card {
  const { options, gkey, thumbUrl, durationSec } = videoOptions(group, tid);
  const target = defaultTarget(options);
  return {
    id: videoCardId(gkey),
    at: Math.max(...group.map((i) => i.addedAt)),
    kind: 'video',
    source: group[0].source,
    target,
    thumbUrl,
    thumbId: thumbUrl != null ? mediaId(thumbUrl) : undefined,
    resLabel: target != null ? resolutionOf(target).label : undefined,
    durationSec,
    mayLackAudio: target != null && !willHaveAudio(target),
    live: group.some((i) => playing.has(i.id)),
  };
}

/** Card for a non-video item. Videos always go through buildVideoCard — doRender
 *  splits them off before reaching here. */
function buildItemCard(item: MediaItem, playing: Set<string>): Card {
  return {
    id: itemCardId(item.id),
    at: item.addedAt,
    kind: item.kind,
    source: item.source,
    target: isDownloadable(item) ? item : undefined,
    // Images preview themselves; audio has no preview and falls to the icon.
    thumbUrl: item.kind === 'image' ? item.url : item.thumbUrl,
    mayLackAudio: false,
    live: playing.has(item.id),
  };
}

/** The card's second line: "0:14 · 720p" for a video, "Photo" (with dimensions
 *  when known) for an image, plus any tag it has earned. */
function cardMeta(card: Card): HTMLElement {
  const meta = document.createElement('p');
  meta.className = 'card-meta';
  let base: string;
  if (card.kind === 'video') {
    const parts = [
      card.durationSec != null ? formatDuration(card.durationSec) : undefined,
      card.resLabel ?? undefined,
    ].filter((p): p is string => p != null);
    base = parts.length > 0 ? parts.join(' · ') : t('kindVideo');
  } else if (card.kind === 'image') {
    base = t('cardPhoto');
  } else {
    base = t('kindAudio');
  }
  meta.textContent = base;

  if (card.target == null) appendTag(meta, t(card.stale ? 'tagSavedGone' : 'unavailable'));
  if (card.kind === 'audio') appendTag(meta, t('tagAudioTrack'));
  if (card.mayLackAudio) appendTag(meta, t('tagMayLackAudio'));
  // No retry button in the grid, so a dead download would otherwise vanish
  // silently. The pick stays put; the card's own Download button re-tries.
  // Never on a stub: a receipt IS a success, and a failure recorded under the
  // same content-derived id belongs to the live card, not the history row.
  if (!card.stale && lastFailed.has(card.id)) appendTag(meta, t('tagFailed'), 'tag-fail');
  return meta;
}

function renderCard(card: Card): HTMLElement {
  const el = document.createElement('article');
  el.className = 'card';
  if (card.live) el.classList.add('is-live');

  const thumb = document.createElement('div');
  thumb.className = 'card-thumb';
  if (card.kind === 'video') thumb.classList.add('is-video');

  // The emoji fallback is its own node, never `thumb.textContent`: the pick and
  // download badges live inside the thumb, and writing textContent would wipe them
  // along with the broken <img>.
  const icon = document.createElement('span');
  icon.textContent = KIND_ICON[card.kind];
  const showIcon = (): void => {
    thumb.classList.remove('is-video'); // the play badge is ::after on .is-video
    thumb.prepend(icon);
  };

  if (card.thumbUrl != null) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      img.remove();
      showIcon();
    });
    img.src = card.thumbUrl;
    thumb.appendChild(img);
  } else {
    showIcon();
  }

  // Selection check (top-right) — feeds the tray.
  const pick = document.createElement('button');
  pick.className = 'pick';
  pick.type = 'button';
  pick.setAttribute('aria-pressed', String(selected.has(card.id)));
  if (card.target != null) {
    pick.title = t('selectItem');
    pick.setAttribute('aria-label', t('selectItem'));
    pick.addEventListener('click', () => {
      if (selected.has(card.id)) selected.delete(card.id);
      else selected.add(card.id);
      // Paint in place instead of re-rendering: a rebuild would tear this very
      // button out from under the click and drop keyboard focus with it.
      pick.setAttribute('aria-pressed', String(selected.has(card.id)));
      paintTray();
    });
  } else {
    // Two distinct honest excuses: a stub is a downloaded receipt whose capture
    // is gone (replaying revives it); anything else is undownloadable media.
    pick.disabled = true;
    const why = t(card.stale ? 'titleSavedGone' : 'titleBlobUnavailable');
    pick.title = why;
    pick.setAttribute('aria-label', why);
  }
  thumb.appendChild(pick);

  // Per-card download (bottom-right) — downloads this one immediately.
  const dl = document.createElement('button');
  dl.className = 'card-dl';
  dl.type = 'button';
  const busy = cardBusy.has(card.id);
  if (card.target != null) {
    dl.title = t('downloadItem');
    dl.setAttribute('aria-label', t('downloadItem'));
    dl.classList.toggle('busy', busy);
    dl.disabled = busy || bulkRunning;
    const target = card.target;
    dl.addEventListener('click', () => void downloadCard(card.id, target));
  } else {
    dl.disabled = true;
    dl.title = t(card.stale ? 'titleSavedGone' : 'titleBlobUnavailable');
    dl.setAttribute('aria-label', t(card.stale ? 'tagSavedGone' : 'unavailable'));
  }
  thumb.appendChild(dl);

  const title = document.createElement('h3');
  title.className = 'card-title';
  title.textContent = t(SOURCE_KEY[card.source]);

  el.append(thumb, title, cardMeta(card));
  return el;
}

// ── Now Playing model ─────────────────────────────────────────────────────────

interface NowState {
  id: string; // the card id (v:gkey / i:id), so a Now Playing save shows in the grid
  kind: MediaKind;
  source: MediaSource;
  thumbUrl?: string;
  durationSec?: number;
  pieces: number; // total captured pieces in this post
  options: MediaItem[]; // quality options (video); a single entry for image/audio
  gkey: string; // qualityChoice key
}

/** The playing item, focused. Prefers a playing video group (with its full quality
 *  ladder); falls back to a playing image. Null when nothing downloadable plays. */
function buildNowState(items: MediaItem[], tid: number | undefined, playing: Set<string>, pieces: number): NowState | null {
  const playingItems = items.filter((i) => playing.has(i.id));
  if (playingItems.length === 0) return null;

  // The playing set often carries only the streamed baseline track, not the video's
  // full quality ladder. Take the playing video's GROUP key, then rebuild the whole
  // group from every captured item that shares it — so Now Playing gets the same
  // duration, resolution and quality options the grid card gets (the DASH reps that
  // carry them aren't necessarily in the playing set).
  const playingVideo = playingItems.find((i) => i.kind === 'video');
  if (playingVideo) {
    const key = videoGroupKey(playingVideo);
    const group = items.filter((i) => i.kind === 'video' && videoGroupKey(i) === key);
    const { options, gkey, thumbUrl, durationSec } = videoOptions(group, tid);
    if (options.length === 0) return null;
    return {
      id: videoCardId(gkey),
      kind: 'video',
      source: playingVideo.source,
      thumbUrl,
      durationSec,
      pieces,
      options,
      gkey,
    };
  }
  const img = playingItems.find((i) => i.kind === 'image' && isDownloadable(i));
  if (!img) return null;
  return {
    id: itemCardId(img.id),
    kind: 'image',
    source: img.source,
    thumbUrl: img.url,
    pieces,
    options: [img],
    gkey: itemCardId(img.id),
  };
}

/** Format the Now Playing / card download label, e.g. "Download MP4 · 1080p". */
function downloadLabel(target: MediaItem): string {
  const ext = extFor(target.kind).toUpperCase();
  const res = resolutionOf(target).label;
  const label = target.kind === 'video' && res !== 'Video' ? `${ext} · ${res}` : ext;
  return t('downloadKind').replace('{label}', label);
}

/** Paint the Now Playing view from a NowState. Wires the quality selector (which
 *  repaints the metadata + button in place) and the single Download button. */
function paintNow(now: NowState | null): void {
  byId('now-empty').hidden = now != null;
  byId('now-content').hidden = now == null;
  if (now == null) return;

  // Chosen representation: the user's pick for this video (persisted), else the setting.
  let target = now.options.find((o) => o.id === qualityChoice.get(now.gkey)) ?? defaultTarget(now.options)!;

  const preview = byId('now-preview');
  preview.classList.toggle('is-video', now.kind === 'video');
  // A real poster as an <img> (so an expired/blocked fbcdn URL falls back to the
  // gradient wash on error); rebuilt each paint.
  preview.querySelector('img')?.remove();
  if (now.thumbUrl != null) {
    const img = document.createElement('img');
    img.alt = '';
    img.addEventListener('error', () => img.remove());
    img.src = now.thumbUrl;
    preview.prepend(img);
  }
  byId('now-badge').textContent = t(KIND_KEY[now.kind]);
  byId('now-dur').textContent = now.durationSec != null ? formatDuration(now.durationSec) : '';

  byId('now-title').textContent = t(SOURCE_KEY[now.source]);
  byId('now-sub').textContent = tn('piecesInPostOne', 'piecesInPost', now.pieces);

  byId('m-format').textContent = extFor(target.kind).toUpperCase();
  byId('m-duration').textContent = now.durationSec != null ? formatDuration(now.durationSec) : '—';

  const dl = byId<HTMLButtonElement>('now-download');
  const paintMeta = (): void => {
    byId('m-resolution').textContent = target.kind === 'video' ? resolutionOf(target).label : '—';
    const busy = cardBusy.has(now.id);
    dl.disabled = busy || bulkRunning;
    dl.textContent = busy
      ? target.audioUrl != null
        ? t('downloadMerging')
        : t('downloadSaving')
      : lastFailed.has(now.id)
        ? t('downloadRetry')
        : downloadLabel(target);
  };

  // Quality selector — a native select, present for every video (disabled when
  // there is only one representation) and hidden for images/audio.
  const quality = byId('now-quality');
  const select = byId<HTMLSelectElement>('now-qselect');
  quality.hidden = now.kind !== 'video';
  if (now.kind === 'video') {
    byId('now-qcount').textContent = tn('qualityOptionsOne', 'qualityOptions', now.options.length);
    select.textContent = '';
    for (const opt of now.options) {
      const o = document.createElement('option');
      o.value = opt.id;
      o.textContent = resolutionOf(opt).label;
      select.appendChild(o);
    }
    select.value = target.id;
    select.disabled = now.options.length <= 1;
    select.onchange = (): void => {
      target = now.options.find((o) => o.id === select.value) ?? now.options[0];
      qualityChoice.set(now.gkey, target.id);
      paintMeta();
    };
  }

  dl.onclick = (): void => void downloadCard(now.id, target);
  paintMeta();
}

// ── Selection tray (Library / Saved) ──────────────────────────────────────────

// The last render's cards, keyed by card id. The pick handler and the bulk run
// have to get from a picked id back to the item to download, and neither can read
// it off the DOM — a rebuild will have replaced the node by then.
const cardsById = new Map<string, Card>();
// The grid cards currently on screen, for the Select all toggle.
let visibleCards: Card[] = [];

/** Paint the tray, which reads `selected`. Deliberately NOT part of the render
 *  signature — toggling a pick repaints these nodes instead of tearing the grid
 *  down under the user's cursor. Hidden entirely outside the grid views. */
function paintTray(): void {
  const n = selected.size;
  const tray = byId('tray');
  // The cart is global across Library/Saved, but the tray must not float over a
  // view with nothing in it — an empty grid (or Now Playing) hides it; the picks
  // survive and reappear when a grid with cards is shown again.
  if (view === 'now' || n === 0 || visibleCards.length === 0) {
    tray.hidden = true;
    syncSelectAll();
    return;
  }
  tray.hidden = false;
  byId('tray-count').textContent = tn('selectedCountOne', 'selectedCount', n);
  const kinds: MediaKind[] = [];
  for (const id of selected) {
    const c = cardsById.get(id);
    if (c) kinds.push(c.kind);
  }
  byId('tray-meta').textContent = composeLine(kinds);

  const btn = byId<HTMLButtonElement>('bulk-dl');
  // A run in flight, or a single card downloading, owns the offscreen document; the
  // tray must not start a second. Enablement is global; only the label is tab-scoped
  // — a run painting "Saving 2/3…" in its own tab must not be stamped over here.
  if (bulkRunning || cardBusy.size > 0) {
    btn.disabled = true;
    if (!bulkRunning || bulkTab !== tabId) btn.textContent = t('downloadSelected').replace('{n}', String(n));
    syncSelectAll();
    return;
  }
  btn.disabled = false;
  btn.textContent = t('downloadSelected').replace('{n}', String(n));
  syncSelectAll();
}

/** Keep the "Select all" / "Clear picks" link in step with whether every
 *  downloadable visible card is already picked. */
function syncSelectAll(): void {
  const targets = visibleCards.filter((c) => c.target != null);
  const allPicked = targets.length > 0 && targets.every((c) => selected.has(c.id));
  byId('select-all').textContent = allPicked ? t('deselectAll') : t('selectAll');
}

/** Download every pick, one at a time. Sequential on purpose: parallel DASH merges
 *  would fight over the single offscreen document, and the tray's progress label
 *  counts a queue, not a race. */
async function runBulk(): Promise<void> {
  if (bulkRunning || cardBusy.size > 0) return;
  // Snapshot the tab. The queue below awaits up to 120s per item, and onActivated
  // flips module `tabId` on a tab switch — these picks, and the saved marks they
  // earn, belong to the tab that made them.
  const tid = tabId;
  // Receipts freeze at queue-build time too: by the time an item's turn comes,
  // a navigation wipe may have rebuilt cardsById empty and the receipt would
  // lose its thumb/duration.
  const queue: { id: string; item: MediaItem; receipt: SavedEntry }[] = [];
  for (const id of selected) {
    const target = cardsById.get(id)?.target;
    if (target != null) queue.push({ id, item: target, receipt: savedEntryFor(id, target) });
  }
  if (queue.length === 0) return;

  const btn = byId<HTMLButtonElement>('bulk-dl');
  bulkRunning = true;
  bulkTab = tid;
  btn.disabled = true;
  const done: string[] = [];
  const failed: string[] = [];
  try {
    for (const [i, { id, item, receipt }] of queue.entries()) {
      // Only in the tab this run belongs to: elsewhere the panel shows a different
      // cart, and #bulk-dl is one shared node — this label would report our queue
      // over their picks.
      if (bulkTab === tabId && view !== 'now') {
        btn.textContent = t('bulkBusy')
          .replace('{i}', String(i + 1))
          .replace('{n}', String(queue.length));
      }
      const ok = item.audioUrl != null ? await startDashDownload(item) : await startDirectDownload(item);
      (ok ? done : failed).push(id);
      // Persist each save as it lands, not as one batch at the end: the download
      // belongs to the SW and the browser, so a panel closed mid-queue leaves the
      // files on disk — a `done` bank still in memory would die with the document.
      if (ok && tid !== undefined && !deadTabs.has(tid)) await addSaved(tid, [receipt]);
    }
  } finally {
    bulkRunning = false;
    bulkTab = undefined;
    // The panel followed a tab switch while the queue ran: onActivated already
    // cleared this tab's state and this run's ids must not re-seed it — fbcdn ids
    // are content-derived, so the same reel open in both tabs would collide.
    if (tid === tabId) {
      // Unpick only what landed: a failure keeps its pick, so pressing Download
      // again retries exactly the items that didn't make it.
      for (const id of done) {
        selected.delete(id);
        lastFailed.delete(id);
      }
      for (const id of failed) lastFailed.add(id);
      lastRenderSig = ''; // the saved list and the failure tags feed the cards
      await render();
    }
    // Unconditional: `bulkRunning` held every tab's tray button disabled, so every
    // tab's button needs the release painted.
    paintTray();
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

// render() is invoked from overlapping async sources (storage events, the 2s tick,
// tab switches); serialize it so two in-flight renders can't append duplicate
// cards, and coalesce bursts into one trailing rerun.
let renderRunning = false;
let renderQueued = false;
let lastRenderSig = '';

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

/** A Saved card rendered from its receipt alone — the live capture is gone.
 *  No target on purpose: receipts store no media URLs (fbcdn signatures rotate),
 *  so there is nothing truthful for a download button to fetch. */
function stubCard(e: SavedEntry): Card {
  return {
    id: e.id,
    at: e.savedAt,
    kind: e.kind,
    source: e.source,
    target: undefined,
    thumbUrl: e.thumbUrl,
    resLabel: e.resLabel,
    durationSec: e.durationSec,
    mayLackAudio: false,
    live: false,
    stale: true,
  };
}

async function doRender(): Promise<void> {
  // Snapshot the tab once: doRender yields at every await, and onActivated can flip
  // module `tabId` mid-render — reading it twice would mix tab A's items with tab
  // B's now-playing. The queued rerun renders the newly-active tab.
  const tid = tabId;
  const [items, savedEntries] = await Promise.all([
    tid === undefined ? Promise.resolve<MediaItem[]>([]) : getMedia(tid),
    // The ledger only feeds the Saved view (its cards and its signature term);
    // the other views skip the read.
    view !== 'saved' || tid === undefined ? Promise.resolve<SavedEntry[]>([]) : getSaved(tid),
  ]);
  const playing =
    tid === undefined ? new Set<string>() : new Set((await selectPlaying(tid, items)).map((i) => i.id));

  // Group videos by asset (one card per video); images/audio are one card each.
  const groups = new Map<string, MediaItem[]>();
  const others: MediaItem[] = [];
  for (const it of items) {
    if (it.kind === 'video') {
      const key = videoGroupKey(it);
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(it);
    } else {
      others.push(it);
    }
  }

  // The declutter settings (videosOnly, minResolution) and the cover dedupe hide
  // cards from the LIBRARY only — flags, not drops: the Saved history must keep
  // rendering a receipt whose card a Library filter hides, and the cart relies
  // on cardsById holding every real card.
  const cards: Card[] = [];
  for (const group of groups.values()) {
    const card = buildVideoCard(group, tid, playing);
    if (settings.minResolution > 0) {
      const maxH = Math.max(0, ...group.map((i) => i.height ?? 0));
      if (maxH > 0 && maxH < settings.minResolution) card.libraryHidden = true;
    }
    cards.push(card);
  }
  // An image card that is only the cover of a Library-VISIBLE video is a dupe
  // there — but only there: its receipt still renders in Saved, and a cover
  // whose video is itself hidden keeps its Library slot exactly as before.
  const shownCovers = new Set(
    cards.filter((c) => !c.libraryHidden).map((c) => c.thumbId).filter((x): x is string => x != null),
  );
  for (const it of others) {
    const card = buildItemCard(it, playing);
    if ((it.kind === 'image' && shownCovers.has(it.id)) || (settings.videosOnly && it.kind !== 'video')) {
      card.libraryHidden = true;
    }
    cards.push(card);
  }
  cards.sort((a, b) => (settings.listOrder === 'oldest' ? a.at - b.at : b.at - a.at));

  cardsById.clear();
  for (const c of cards) cardsById.set(c.id, c);
  // Forget picks whose card is gone: evicted from storage or left behind by a
  // tab switch. Neither a sub-filter nor a declutter setting drops one — the
  // picks are a cart, and hiding a card from the Library must not empty it.
  let pruned = false;
  for (const id of [...selected]) {
    if (cardsById.has(id)) continue;
    selected.delete(id);
    pruned = true;
  }

  // Pieces = the cards of the post on screen right now (the live ones), not the
  // whole tab's capture count. Now Playing state is only built for its own view.
  const now =
    view === 'now' ? buildNowState(items, tid, playing, cards.filter((c) => c.live).length) : null;
  // Library hides the declutter-flagged cards. Saved renders the receipt ledger
  // in download order: the live card when the capture still exists (a real
  // re-download with fresh URLs), a stub frozen from the receipt when it does
  // not — the stub revives by itself once a replay re-captures the same
  // content-derived id. Both views then narrow by the media sub-filter.
  const orderedSaved = settings.listOrder === 'oldest' ? savedEntries : [...savedEntries].reverse();
  const base =
    view === 'saved'
      ? orderedSaved.map((e) => cardsById.get(e.id) ?? stubCard(e))
      : cards.filter((c) => !c.libraryHidden);
  const gridCards =
    view === 'now' ? [] : base.filter((c) => mediaFilter === 'all' || c.kind === mediaFilter);

  // Skip the DOM rebuild when nothing visible changed: tearing the grid or the
  // Now Playing selector down every ≤2s drops focus and re-announces the aria-live
  // region. The signature covers everything painted — except `selected` (paints in
  // place, see paintTray) and the chosen quality (paints in place, see paintNow).
  const nowSig =
    now == null
      ? 'none'
      : `${now.id}|${now.thumbUrl ?? ''}|${now.durationSec ?? ''}|${now.pieces}|${now.kind}|${now.options
          .map((o) => o.id)
          .join('~')}|${cardBusy.has(now.id) ? 1 : 0}|${lastFailed.has(now.id) ? 1 : 0}`;
  const sig = [
    view,
    mediaFilter,
    getLang(),
    String(offscreenAvailable),
    String(bulkRunning),
    JSON.stringify([
      settings.listOrder,
      settings.videosOnly,
      settings.minResolution,
      settings.directDownload,
      settings.defaultQuality,
    ]),
    view === 'now' ? nowSig : '',
    view === 'saved' ? savedEntries.map((e) => e.id).join(',') : '',
    view === 'now'
      ? ''
      : gridCards
          .map(
            (c) =>
              `${c.id}|${c.thumbUrl ?? ''}|${c.resLabel ?? ''}|${c.durationSec ?? ''}|${
                c.target != null ? 1 : 0
              }|${c.mayLackAudio ? 1 : 0}|${c.live ? 1 : 0}|${lastFailed.has(c.id) ? 1 : 0}|${
                cardBusy.has(c.id) ? 1 : 0
              }|${c.stale ? 1 : 0}`, // stale bit: a stub→live revival must repaint
          )
          .join('\n'),
  ].join('\n');
  visibleCards = gridCards;
  if (sig === lastRenderSig) {
    // `selected` is out of the signature (it paints in place), but the prune above
    // is storage-driven, not a click — a pick the active filter hides can be
    // dropped without moving the signature, leaving the tray offering a gone item.
    if (pruned) paintTray();
    return;
  }
  lastRenderSig = sig;

  byId('view-now').hidden = view !== 'now';
  byId('view-grid').hidden = view === 'now';

  if (view === 'now') {
    paintNow(now);
    paintTray();
    return;
  }

  // Grid heading + counts, per Library vs Saved.
  byId('grid-title').textContent = view === 'saved' ? t('savedTitle') : t('libraryTitle');
  byId('grid-sub').textContent = view === 'saved' ? t('savedSubtitle') : t('librarySubtitle');
  const count = byId('grid-count');
  count.hidden = gridCards.length === 0;
  count.textContent = tn('foundCountOne', 'foundCount', gridCards.length);

  const empty = byId('grid-empty');
  empty.hidden = gridCards.length > 0;
  // "Your picks / Select all" would read oddly above an empty-state message.
  byId('picks-head').hidden = gridCards.length === 0;
  if (gridCards.length === 0) {
    byId('grid-empty-title').textContent = view === 'saved' ? t('savedEmptyTitle') : t('libraryEmptyTitle');
    byId('grid-empty-body').textContent = view === 'saved' ? t('savedEmptyBody') : t('libraryEmptyBody');
  }

  const list = byId('list');
  list.textContent = '';
  for (const c of gridCards) list.appendChild(renderCard(c));

  paintTray();
}

// ── View + filter wiring ──────────────────────────────────────────────────────

function pressOnly(nav: HTMLElement, active: HTMLElement): void {
  nav.querySelectorAll<HTMLButtonElement>('[aria-pressed]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b === active));
  });
}

function setupViews(): void {
  const nav = byId('views');
  nav.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.view-pill');
    if (btn == null || !nav.contains(btn)) return;
    view = (btn.dataset.view as View | undefined) ?? 'now';
    pressOnly(nav, btn);
    lastRenderSig = '';
    void render();
  });
}

function setupFilters(): void {
  const nav = byId('filters');
  nav.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.chip');
    if (btn == null || !nav.contains(btn)) return;
    mediaFilter = (btn.dataset.filter as MediaFilter | undefined) ?? 'all';
    pressOnly(nav, btn);
    lastRenderSig = '';
    void render();
  });
}

function setupSelectAll(): void {
  byId('select-all').addEventListener('click', () => {
    const targets = visibleCards.filter((c) => c.target != null);
    const allPicked = targets.length > 0 && targets.every((c) => selected.has(c.id));
    for (const c of targets) {
      if (allPicked) selected.delete(c.id);
      else selected.add(c.id);
    }
    lastRenderSig = ''; // rebuild so every card's pick state repaints
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
  setupViews();
  setupFilters();
  setupSelectAll();
  setupLangToggle();
  setupSettings();
  localize();

  byId('bulk-dl').addEventListener('click', () => void runBulk());

  byId('clear').addEventListener('click', async () => {
    if (settings.confirmClear && !window.confirm(t('confirmClearPrompt'))) return;
    // The picks and the failure tags point at items about to stop existing; drop
    // them here rather than leaving render() to prune a cart whose contents went away.
    selected.clear();
    lastFailed.clear();
    if (tabId !== undefined) {
      // Route through the worker so the wipe serializes on the same write chain as
      // capture writes (a panel-side clearTab can't, and the list would resurrect).
      // The worker also resets the badge once the removal lands.
      await chrome.runtime.sendMessage({ type: 'FACESCRAP_CLEAR_TAB', tabId } satisfies ClearTabMsg);
    }
    lastRenderSig = '';
    await render();
  });

  // New media captured (or cleared) for the tracked tab → re-render live. Only keys
  // for OUR tab matter — other tabs' churn must not force extra renders.
  chrome.storage.session.onChanged.addListener((changes) => {
    if (tabId === undefined) return;
    const tid = tabId;
    // A nav/close reset (clearTab) removes media_/playing_/recent_/bind_ for the tab
    // (newValue undefined). The panel document survives an F5, so treat that
    // deletion as a hard reset: purge this tab's in-memory bindings + last-live and
    // cancel any pending flush, so a debounced write can't resurrect bind_ after it
    // was wiped and the panel stops showing the pre-reload video.
    const mediaCh = changes[`media_${tid}`];
    const playingCh = changes[`playing_${tid}`];
    if ((mediaCh && mediaCh.newValue === undefined) || (playingCh && playingCh.newValue === undefined)) {
      purgeTabBindings(tid);
    }
    if (
      `media_${tid}` in changes ||
      `playing_${tid}` in changes ||
      `recent_${tid}` in changes ||
      `saved_${tid}` in changes ||
      'caps' in changes
    ) {
      void render();
    }
  });

  // Forget the last-live video of tabs that close (panel-local memory), and
  // remember the tab is dead so a draining download can't resurrect its saved_.
  chrome.tabs.onRemoved.addListener((id) => {
    forgetLastLive(id);
    deadTabs.add(id);
  });

  // Keep language and settings in sync if another view (a second panel in another
  // window, or the popup) changes them.
  chrome.storage.local.onChanged.addListener((changes) => {
    const next = changes[LANG_KEY]?.newValue;
    if ((next === 'en' || next === 'es') && next !== getLang()) {
      setLang(next);
      localize();
      lastRenderSig = '';
      void render();
    }
    if ('settings' in changes) {
      void (async () => {
        settings = await loadSettings();
        reflectSettings();
        lastRenderSig = '';
        await render();
      })();
    }
  });

  // Follow the active tab within this window as the user switches tabs.
  chrome.tabs.onActivated.addListener(async (info) => {
    if (windowId !== undefined && info.windowId !== windowId) return;
    flushBindingsNow(); // persist the OUTGOING tab's learning before switching
    tabId = info.tabId;
    // Picks, failures, per-card busy and quality choices belong to the tab that
    // made them: the incoming tab's items are different items, and an id that
    // happens to collide would arrive pre-picked. lastRenderSig goes too — two
    // empty tabs share a signature, and a skipped render would leave the outgoing
    // tab's grid on screen.
    selected.clear();
    lastFailed.clear();
    cardBusy.clear();
    qualityChoice.clear();
    lastRenderSig = '';
    await loadBindings(info.tabId); // restore the incoming tab's bindings before its first render
    void render();
  });

  // Safety net: keep Now Playing fresh even if a storage event is missed. An
  // unchanged signature still skips the rebuild, so a quiet tab costs one selectPlaying.
  window.setInterval(() => void render(), 2000);

  // Best-effort: persist learning captured within the 1s debounce window when the
  // panel is torn down.
  window.addEventListener('pagehide', flushBindingsNow);

  await render();
});
