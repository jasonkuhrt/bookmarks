/**
 * Every test, and every process a test spawns, starts with each bookmark path in a throwaway
 * folder: no test can read or write the real YAML, sync state, Safari or Chrome. A test that
 * needs a path sets it; one that forgets gets an empty sandbox, never the user's bookmarks.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "bookmarks-test-"));

process.env["BOOKMARKS_CONFIG_DIR"] = join(root, "config");
process.env["BOOKMARKS_STATE_DIR"] = join(root, "state");
process.env["BOOKMARKS_SAFARI_PLIST_PATH"] = join(root, "Safari", "Bookmarks.plist");
process.env["BOOKMARKS_SAFARI_TABS_DB_PATH"] = join(root, "Safari", "SafariTabs.db");
process.env["BOOKMARKS_CHROME_DATA_DIR"] = join(root, "Chrome");
process.env["BOOKMARKS_FORCE_BROWSER_RUNNING"] = "";
