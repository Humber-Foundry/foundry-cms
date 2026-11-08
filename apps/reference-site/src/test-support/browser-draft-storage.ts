/**
 * Browser tests share one origin, so the draft outbox in IndexedDB and the
 * stale-workspace recovery copies in local storage outlive the test that wrote
 * them. A save also outlives its editor: once it has started, it waits for the
 * workspace lock, records its attempt in the outbox, and then sends, even if
 * the editor has gone away meanwhile.
 *
 * Left alone, such a save lands in the next test. It writes an outbox record
 * after that test began, and its request reaches whatever `fetch` the next
 * test stubbed. The browser setup file calls `settleBrowserDraftStorage`
 * before and after every test, so each test starts with no save waiting to
 * send and with empty storage.
 */
const settleLimitMilliseconds = 2_000;

/** The prefix of every Web Lock the content editor takes. */
const contentEditorLockPrefix = "foundry-cms:";

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    // An outbox write closes its connection when it finishes, which unblocks
    // the deletion. A connection still open past the limit would otherwise
    // hold the deletion until the test times out, so fail and name it.
    let blockedTimer: number | undefined;
    request.onblocked = () => {
      blockedTimer = window.setTimeout(
        () => reject(new Error(`browser_draft_storage_still_open: ${name}`)),
        settleLimitMilliseconds,
      );
    };
    request.onsuccess = () => {
      window.clearTimeout(blockedTimer);
      resolve();
    };
    request.onerror = () => {
      window.clearTimeout(blockedTimer);
      reject(request.error);
    };
  });
}

/**
 * Waits until the content editor holds and wants no Web Lock. A save records
 * its attempt under the workspace lock and calls `fetch` as soon as that lock
 * is released, so once the editor's locks are idle, no save is still waiting
 * to send. The browser test beside this file checks that.
 *
 * This does not wait for a response. A test whose `fetch` stub answers later
 * lets that save carry on afterwards in its own workspace's records.
 *
 * A lock that stays busy past the limit fails the test by name: that is draft
 * work the test left running, and hiding it would hide the leak.
 */
async function waitForIdleEditorLocks(): Promise<void> {
  const deadline = performance.now() + settleLimitMilliseconds;
  for (;;) {
    const { held = [], pending = [] } = await navigator.locks.query();
    const busy = [...held, ...pending].flatMap(({ name }) =>
      name?.startsWith(contentEditorLockPrefix) ? [name] : [],
    );
    if (busy.length === 0) {
      return;
    }
    if (performance.now() > deadline) {
      throw new Error(`browser_draft_work_still_running: ${busy.join(", ")}`);
    }
    await pause(10);
  }
}

export async function settleBrowserDraftStorage(): Promise<void> {
  await waitForIdleEditorLocks();
  const databases = await indexedDB.databases();
  await Promise.all(
    databases.flatMap(({ name }) =>
      name === undefined ? [] : [deleteDatabase(name)],
    ),
  );
  window.localStorage.clear();
}
