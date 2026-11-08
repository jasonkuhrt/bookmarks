#!/usr/bin/env bun
/** One-time cutover tool. All validation finishes before either input is rewritten. */
import { Effect, Schema } from "effect";
import * as Fs from "node:fs/promises";
import * as Yaml from "yaml";
import * as ReadingList from "../src/lib/reading-list.ts";
import * as Baseline from "../src/lib/baseline.ts";
import * as Canonical from "../src/lib/canonical.ts";
import * as Chrome from "../src/lib/chrome.ts";
import * as Fingerprint from "../src/lib/fingerprint.ts";
import * as Targets from "../src/lib/targets.ts";
import * as YamlModule from "../src/lib/yaml.ts";
import {
  BookmarkFolder,
  BookmarkLeaf,
  BookmarkSection,
  BookmarkTree,
  ReadingListItem,
  TargetState,
} from "../src/lib/schema/__.ts";

const RecordSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const OldTree = Schema.Struct({
  ...BookmarkTree.fields,
  reading_list: Schema.optional(BookmarkSection),
});
const OldBaselines = Schema.Struct({
  version: Schema.Literal(1),
  targets: Schema.Record({ key: Schema.String, value: OldTree }),
});
const record = (value: unknown) => Schema.decodeUnknownSync(RecordSchema)(value);
const items = (nodes: BookmarkSection | undefined): readonly ReadingListItem[] =>
  ReadingList.canonical(
    (nodes ?? []).map((node) => {
      if (!BookmarkLeaf.is(node))
        throw new Error("Reading List migration refuses folders; flatten the list first.");
      return ReadingListItem.make({ name: node.name, url: node.url, read: false });
    }),
  );
const noOverlay = (value: unknown, path: string): void => {
  if (value === undefined) return;
  const object = record(value);
  if ("reading_list" in object)
    throw new Error(`${path}.reading_list overlay is refused; the Reading List must be shared.`);
};

/** Pure migration, including the Chrome-file precondition. No browser or filesystem access. */
export const migrate = (
  yamlText: string,
  baselineText: string,
  chromeFiles: Readonly<Record<string, BookmarkTree>>,
) => {
  const document = record(Yaml.parse(yamlText));
  noOverlay(document["safari"], "safari");
  noOverlay(document["chrome"], "chrome");
  const chrome = document["chrome"] === undefined ? {} : record(document["chrome"]);
  const profiles = chrome["profiles"] === undefined ? {} : record(chrome["profiles"]);
  for (const [key, profile] of Object.entries(profiles))
    noOverlay(profile, `chrome.profiles.${key}`);
  const all = record(document["all"]);
  const oldItems =
    all["reading_list"] === undefined
      ? undefined
      : Schema.decodeUnknownSync(BookmarkSection)(all["reading_list"]);
  const migratedYaml = {
    ...document,
    all: { ...all, reading_list: items(oldItems).map(({ name, url }) => ({ name, url })) },
  };
  const old = Schema.decodeUnknownSync(OldBaselines)(JSON.parse(baselineText));
  const targets: Record<string, TargetState> = {};
  for (const [key, value] of Object.entries(old.targets)) {
    const tree = Canonical.canonicalTree(
      BookmarkTree.make({ bar: value.bar, menu: value.menu, mobile: value.mobile }),
    );
    if (key.startsWith("chrome/")) {
      const migrated = BookmarkTree.make({
        bar: tree.bar,
        mobile: tree.mobile,
        menu: [
          ...(tree.menu ?? []),
          BookmarkFolder.make({ name: "Read Later", children: value.reading_list ?? [] }),
        ],
      });
      const disk = chromeFiles[key];
      if (!disk || Fingerprint.ofTree(migrated) !== Fingerprint.ofTree(disk))
        throw new Error(
          `Chrome file mismatch for ${key}. Migrated baseline: ${JSON.stringify(migrated)}; Chrome file: ${JSON.stringify(disk ?? null)}`,
        );
      targets[key] = TargetState.make({ tree: migrated, readingList: [] });
    } else targets[key] = TargetState.make({ tree, readingList: items(value.reading_list) });
  }
  return { yaml: Yaml.stringify(migratedYaml), baselines: targets };
};

const main = Effect.gen(function* () {
  const args = process.argv.slice(2);
  const paths = args.filter((arg) => arg !== "--dry-run");
  const [yamlPath, baselinePath] = paths;
  if (!yamlPath || !baselinePath || paths.length !== 2)
    return yield* Effect.fail(
      new Error("Usage: bun scripts/migrate-reading-list.ts <yaml> <v1-baselines> [--dry-run]"),
    );
  const chromeFiles: Record<string, BookmarkTree> = {};
  for (const target of yield* Targets.discoverChromeTargets())
    chromeFiles[Targets.keyOf(target)] = yield* Chrome.readBookmarks(target.path);
  const result = yield* Effect.tryPromise({
    try: async () =>
      migrate(
        await Fs.readFile(yamlPath, "utf8"),
        await Fs.readFile(baselinePath, "utf8"),
        chromeFiles,
      ),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
  // Use the production codecs as the final preflight, including URL validation.
  const config = Canonical.canonicalConfig(
    yield* YamlModule.decodeDocument(Yaml.parse(result.yaml), yamlPath),
  );
  const yaml = yield* YamlModule.render(config);
  const baselines = yield* Baseline.render(result.baselines);
  const encodedBaseline: unknown = JSON.parse(baselines);
  if (args.includes("--dry-run"))
    console.log(JSON.stringify({ yaml, baselines: encodedBaseline }, null, 2));
  else
    yield* Effect.tryPromise({
      try: async () => {
        await Fs.writeFile(yamlPath, yaml);
        await Fs.writeFile(baselinePath, baselines);
      },
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
});
if (import.meta.main) await Effect.runPromise(main);
