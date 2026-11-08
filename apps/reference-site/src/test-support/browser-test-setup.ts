import { afterEach, beforeEach } from "vitest";

import { settleBrowserDraftStorage } from "./browser-draft-storage";

// Runs around every browser test. vitest.browser.config.ts sets
// `sequence.hooks` to "stack", so this after hook runs last, once the test
// file's own hooks have unmounted its editors. Any save they started has then
// sent its request before the next test begins. See browser-draft-storage.ts.
beforeEach(settleBrowserDraftStorage);
afterEach(settleBrowserDraftStorage);
