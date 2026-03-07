import { serialize } from "@plist/binary.serialize";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "..", "..", "fixtures");

export const CHROME_BOOKMARKS_FIXTURE_PATH = join(FIXTURES_DIR, "chrome", "Bookmarks.json");
export const SAFARI_BOOKMARKS_FIXTURE_PATH = join(FIXTURES_DIR, "safari", "Bookmarks.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readJsonRecord = async (path: string): Promise<Record<string, unknown>> => {
  const value: unknown = JSON.parse(await Bun.file(path).text());
  if (!isRecord(value)) {
    throw new Error(`Expected JSON object in fixture ${path}`);
  }
  return value;
};

export const copyChromeBookmarksFixture = async (destination: string): Promise<void> => {
  await copyFile(CHROME_BOOKMARKS_FIXTURE_PATH, destination);
};

export const readChromeBookmarksFixture = async (): Promise<Record<string, unknown>> =>
  readJsonRecord(CHROME_BOOKMARKS_FIXTURE_PATH);

export const writeSafariBookmarksFixture = async (destination: string): Promise<void> => {
  const source = await readJsonRecord(SAFARI_BOOKMARKS_FIXTURE_PATH);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Fixture JSON is repository-controlled and only contains plist-serializable values.
  await Bun.write(destination, serialize(source as Parameters<typeof serialize>[0]));
};
