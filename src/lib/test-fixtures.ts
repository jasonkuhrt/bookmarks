import { serialize } from "@plist/binary.serialize"
import { copyFile } from "node:fs/promises"
import { join } from "node:path"

const FIXTURES_DIR = join(import.meta.dir, "..", "..", "fixtures")

export const CHROME_BOOKMARKS_FIXTURE_PATH = join(FIXTURES_DIR, "chrome", "Bookmarks.json")
export const SAFARI_BOOKMARKS_FIXTURE_PATH = join(FIXTURES_DIR, "safari", "Bookmarks.json")

export const copyChromeBookmarksFixture = async (destination: string): Promise<void> => {
  await copyFile(CHROME_BOOKMARKS_FIXTURE_PATH, destination)
}

export const readChromeBookmarksFixture = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await Bun.file(CHROME_BOOKMARKS_FIXTURE_PATH).text()) as Record<string, unknown>

export const writeSafariBookmarksFixture = async (destination: string): Promise<void> => {
  const source = JSON.parse(await Bun.file(SAFARI_BOOKMARKS_FIXTURE_PATH).text()) as Record<string, unknown>
  await Bun.write(destination, serialize(source as Parameters<typeof serialize>[0]))
}
