// Only panel-rendered strings live here; service-worker/offscreen errors stay console-only English.
// Pure module (no chrome.*) so it bundles in any context and is unit-testable.

export type Lang = 'en' | 'es';

export type MsgKey =
  | 'clear'
  | 'filterPlaying'
  | 'filterAll'
  | 'filterVideos'
  | 'filterImages'
  | 'emptyTitle'
  | 'emptyState'
  | 'footerNote'
  | 'bannerDegraded'
  | 'download'
  | 'downloadWithAudio'
  | 'merging'
  | 'retry'
  | 'unavailable'
  | 'saving'
  | 'saveCover'
  | 'tagMayLackAudio'
  | 'tagAudioTrack'
  | 'titleBlobUnavailable'
  | 'titleClear'
  | 'settings'
  | 'settingsLanguage'
  | 'titleSettings'
  | 'titleCloseSettings'
  | 'settingsDownloads'
  | 'settingsPanel'
  | 'settingsCapture'
  | 'settingsTemplate'
  | 'settingsSubfolder'
  | 'settingsQuality'
  | 'settingsDirect'
  | 'settingsFollowLang'
  | 'settingsOrder'
  | 'settingsConfirmClear'
  | 'settingsVideosOnly'
  | 'settingsMinRes'
  | 'settingsMaxItems'
  | 'qualityHighest'
  | 'qualityLowest'
  | 'qualityAsk'
  | 'orderNewest'
  | 'orderOldest'
  | 'resNone'
  | 'maxUnlimited'
  | 'confirmClearPrompt'
  | 'sourceReel'
  | 'sourceStory'
  | 'sourceHighlight'
  | 'sourceVideo'
  | 'sourcePage'
  | 'kindVideo'
  | 'kindImage'
  | 'kindAudio';

const MESSAGES: Record<Lang, Record<MsgKey, string>> = {
  en: {
    clear: 'Clear',
    filterPlaying: '▶ Now playing',
    filterAll: 'All',
    filterVideos: 'Videos',
    filterImages: 'Images',
    emptyTitle: 'No signal',
    emptyState:
      'Play a reel or story. You\'ll see only what you\'re watching now — if something is missing, check "All".',
    footerNote:
      'HD videos are merged with audio automatically. Only download content you have the rights to.',
    bannerDegraded:
      'This browser can\'t merge audio and video: HD saves as video only. Use Chrome or Edge to include audio.',
    download: 'Download',
    downloadWithAudio: 'Download with audio',
    merging: 'Merging…',
    retry: 'Retry',
    unavailable: 'Unavailable',
    saving: 'Saving…',
    saveCover: 'Save cover image',
    tagMayLackAudio: 'may lack audio',
    tagAudioTrack: 'audio track',
    titleBlobUnavailable: 'This media is an MSE blob: and can\'t be saved.',
    titleClear: 'Empty the list',
    settings: 'Settings',
    settingsLanguage: 'Language',
    titleSettings: 'Settings',
    titleCloseSettings: 'Close settings',
    settingsDownloads: 'Downloads',
    settingsPanel: 'Panel',
    settingsCapture: 'Capture',
    settingsTemplate: 'Filename',
    settingsSubfolder: 'Save in "FaceScrap/" subfolder',
    settingsQuality: 'Default quality',
    settingsDirect: 'Direct download (no audio merge)',
    settingsFollowLang: 'Follow browser language',
    settingsOrder: 'List order',
    settingsConfirmClear: 'Confirm before clearing',
    settingsVideosOnly: 'Videos only',
    settingsMinRes: 'Minimum resolution',
    settingsMaxItems: 'Max saved items',
    qualityHighest: 'Highest',
    qualityLowest: 'Lowest',
    qualityAsk: 'Ask',
    orderNewest: 'Newest first',
    orderOldest: 'Oldest first',
    resNone: 'No minimum',
    maxUnlimited: 'Unlimited',
    confirmClearPrompt: 'Clear all captured items for this tab?',
    sourceReel: 'Reel',
    sourceStory: 'Story',
    sourceHighlight: 'Highlight',
    sourceVideo: 'Video',
    sourcePage: 'Image',
    kindVideo: 'Video',
    kindImage: 'Image',
    kindAudio: 'Audio',
  },
  es: {
    clear: 'Limpiar',
    filterPlaying: '▶ Reproduciéndose',
    filterAll: 'Todo',
    filterVideos: 'Videos',
    filterImages: 'Imágenes',
    emptyTitle: 'Sin señal',
    emptyState:
      'Reproduce un reel o historia. Aquí verás solo lo que estás viendo ahora — si algo no aparece, míralo en «Todo».',
    footerNote:
      'Los videos HD se unen con audio automáticamente. Descarga solo contenido sobre el que tengas derechos.',
    bannerDegraded:
      'Este navegador no puede unir audio y video: los HD se descargan solo con imagen. Usa Chrome o Edge para incluir el audio.',
    download: 'Descargar',
    downloadWithAudio: 'Descargar con audio',
    merging: 'Uniendo…',
    retry: 'Reintentar',
    unavailable: 'No disponible',
    saving: 'Guardando…',
    saveCover: 'Guardar portada',
    tagMayLackAudio: 'puede venir sin audio',
    tagAudioTrack: 'pista de audio',
    titleBlobUnavailable: 'Este medio es un blob: de MSE y no puede guardarse.',
    titleClear: 'Vaciar lista',
    settings: 'Configuración',
    settingsLanguage: 'Idioma',
    titleSettings: 'Configuración',
    titleCloseSettings: 'Cerrar configuración',
    settingsDownloads: 'Descargas',
    settingsPanel: 'Panel',
    settingsCapture: 'Captura',
    settingsTemplate: 'Nombre de archivo',
    settingsSubfolder: 'Guardar en subcarpeta «FaceScrap/»',
    settingsQuality: 'Calidad por defecto',
    settingsDirect: 'Descarga directa (sin unir audio)',
    settingsFollowLang: 'Seguir idioma del navegador',
    settingsOrder: 'Orden de la lista',
    settingsConfirmClear: 'Confirmar antes de vaciar',
    settingsVideosOnly: 'Solo videos',
    settingsMinRes: 'Resolución mínima',
    settingsMaxItems: 'Máx. de items',
    qualityHighest: 'Mayor',
    qualityLowest: 'Menor',
    qualityAsk: 'Preguntar',
    orderNewest: 'Más nuevo primero',
    orderOldest: 'Más viejo primero',
    resNone: 'Sin mínimo',
    maxUnlimited: 'Sin límite',
    confirmClearPrompt: '¿Vaciar todos los items capturados de esta pestaña?',
    sourceReel: 'Reel',
    sourceStory: 'Historia',
    sourceHighlight: 'Destacada',
    sourceVideo: 'Video',
    sourcePage: 'Imagen',
    kindVideo: 'Video',
    kindImage: 'Imagen',
    kindAudio: 'Audio',
  },
};

let currentLang: Lang = 'en';

export function setLang(lang: Lang): void {
  currentLang = lang;
}

export function getLang(): Lang {
  return currentLang;
}

export function t(key: MsgKey): string {
  return MESSAGES[currentLang][key];
}
