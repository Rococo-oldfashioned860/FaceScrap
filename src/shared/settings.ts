// User settings, persisted in chrome.storage.local under a single key. Read by the
// side panel (all fields) and the service worker (maxItems only). A partial or
// corrupt stored shape is coerced back onto the defaults, so adding a field here
// is backward-safe and a bad value can never reach a filename builder or a splice().

export type QualityPref = 'highest' | 'lowest' | 'ask';
export type ListOrder = 'newest' | 'oldest';

export interface Settings {
  /** Filename pattern; tokens {source} {date} {id} are substituted, the rest kept. */
  filenameTemplate: string;
  /** Save downloads inside a "FaceScrap/" subfolder of the Downloads directory. */
  subfolder: boolean;
  /** Which representation the quality picker preselects; 'ask' opens the Save-As dialog. */
  defaultQuality: QualityPref;
  /** Skip the DASH audio+video remux and download the video track directly (muted). */
  directDownload: boolean;
  /** Pick EN/ES from navigator.language instead of the manual toggle. */
  followBrowserLang: boolean;
  listOrder: ListOrder;
  /** Ask for confirmation before the Clear button wipes the list. */
  confirmClear: boolean;
  /** View filter: show only video rows (images/audio hidden, not dropped). */
  videosOnly: boolean;
  /** View filter: hide video groups whose best height is below this (0 = off). */
  minResolution: number;
  /** Per-tab retention cap in storage (0 = unlimited). */
  maxItems: number;
}

export const DEFAULT_SETTINGS: Settings = {
  filenameTemplate: '{source}-{date}-{id}',
  subfolder: true,
  defaultQuality: 'highest',
  directDownload: false,
  followBrowserLang: false,
  listOrder: 'newest',
  confirmClear: false,
  videosOnly: false,
  minResolution: 0,
  maxItems: 1500,
};

const SETTINGS_KEY = 'settings';
const QUALITY: QualityPref[] = ['highest', 'lowest', 'ask'];
const ORDER: ListOrder[] = ['newest', 'oldest'];

/** Merge a stored (possibly partial/corrupt) object onto the defaults, coercing
 *  every field so downstream code can trust the shape. */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw ?? {}) as Record<string, unknown>;
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
  const num = (v: unknown, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d;
  return {
    filenameTemplate:
      typeof r.filenameTemplate === 'string' && r.filenameTemplate.length > 0 && r.filenameTemplate.length <= 200
        ? r.filenameTemplate
        : DEFAULT_SETTINGS.filenameTemplate,
    subfolder: bool(r.subfolder, DEFAULT_SETTINGS.subfolder),
    defaultQuality: QUALITY.includes(r.defaultQuality as QualityPref)
      ? (r.defaultQuality as QualityPref)
      : DEFAULT_SETTINGS.defaultQuality,
    directDownload: bool(r.directDownload, DEFAULT_SETTINGS.directDownload),
    followBrowserLang: bool(r.followBrowserLang, DEFAULT_SETTINGS.followBrowserLang),
    listOrder: ORDER.includes(r.listOrder as ListOrder) ? (r.listOrder as ListOrder) : DEFAULT_SETTINGS.listOrder,
    confirmClear: bool(r.confirmClear, DEFAULT_SETTINGS.confirmClear),
    videosOnly: bool(r.videosOnly, DEFAULT_SETTINGS.videosOnly),
    minResolution: num(r.minResolution, DEFAULT_SETTINGS.minResolution),
    maxItems: num(r.maxItems, DEFAULT_SETTINGS.maxItems),
  };
}

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
    return normalizeSettings(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const next = normalizeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
}
