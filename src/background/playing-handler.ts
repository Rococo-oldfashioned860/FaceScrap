import { isFbcdn } from '../shared/media';
import { normalizePlayingDetectedAt, type NowPlayingAck, type NowPlayingMsg } from '../shared/messages';
import { boundPlayingMark, setPlaying } from '../shared/storage';

/** Validate and persist one untrusted content-script observation. Kept outside
 *  service-worker.ts so its important ACK-after-storage contract is testable
 *  without booting every Chrome event API. */
export async function persistNowPlayingMessage(
  tabId: number,
  message: NowPlayingMsg,
  receivedAt = Date.now(),
): Promise<NowPlayingAck> {
  const detectedAt = normalizePlayingDetectedAt(message.detectedAt, receivedAt);
  if (detectedAt == null) {
    return { ok: false, retryable: false, error: 'Invalid or expired playing observation.' };
  }

  const ids = Array.isArray(message.ids)
    ? (message.ids as unknown[]).slice(0, 24).map((value) => String(value).slice(0, 256))
    : [];
  const coverUrls = Array.isArray(message.covers)
    ? (message.covers as unknown[])
        .filter((cover): cover is string => typeof cover === 'string' && cover.length <= 8192 && isFbcdn(cover))
        .slice(0, 3)
    : undefined;

  try {
    const ok = await setPlaying(tabId, {
      ids,
      hasVideo: Boolean(message.hasVideo),
      vid: typeof message.vid === 'string' && /^\d{5,20}$/.test(message.vid) ? message.vid : undefined,
      coverUrls,
      mark:
        typeof message.mark === 'string' && message.mark.length > 0
          ? boundPlayingMark(message.mark)
          : undefined,
      at: detectedAt,
    }, receivedAt);
    return ok
      ? { ok: true }
      : { ok: false, retryable: true, error: 'Playing state storage failed.' };
  } catch (err) {
    return {
      ok: false,
      retryable: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
