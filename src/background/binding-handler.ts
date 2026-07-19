import type { PersistBindingsAck, PersistBindingsMsg } from '../shared/messages';
import {
  persistBindings,
  sanitizeBindState,
  type PersistBindingsRequest,
  type PersistBindingsResult,
} from '../shared/storage';
import { ClosedTabError, type TabLifecycle } from './tab-lifecycle';

type Persist = (tabId: number, request: PersistBindingsRequest) => Promise<PersistBindingsResult>;

function validCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function createBindingMessageHandler(tabLifecycle: TabLifecycle, persist: Persist = persistBindings) {
  return (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: PersistBindingsAck) => void,
  ): true | undefined => {
    const raw = message as Partial<PersistBindingsMsg> | undefined;
    if (raw?.type !== 'FACESCRAP_PERSIST_BINDINGS') return undefined;

    if (sender.tab) {
      sendResponse({ ok: false, retryable: false, error: 'Unauthorized request.' });
      return true;
    }
    if (
      !validCounter(raw.tabId) ||
      !validCounter(raw.generation) ||
      !validCounter(raw.baseRevision) ||
      sanitizeBindState(raw.state) == null ||
      tabLifecycle.isDead(raw.tabId)
    ) {
      sendResponse({ ok: false, retryable: false, error: 'Invalid or closed binding request.' });
      return true;
    }

    const request: PersistBindingsRequest = {
      generation: raw.generation,
      baseRevision: raw.baseRevision,
      state: raw.state as PersistBindingsMsg['state'],
    };
    tabLifecycle.runIfLive(raw.tabId, () => persist(raw.tabId as number, request)).then(
      (result) => {
        if (result.ok) {
          sendResponse(result);
        } else {
          sendResponse({
            ok: false,
            retryable: true,
            error: 'Binding revision conflict.',
            conflict: result.record,
          });
        }
      },
      (error) => {
        sendResponse({
          ok: false,
          retryable: !(error instanceof ClosedTabError),
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return true;
  };
}
