import * as Fs from "node:fs/promises";

/** `waiting`: a sync left changes for a browser that was open, and runs again when it quits. */
export type DaemonPhase =
  | "error"
  | "idle"
  | "queued"
  | "starting"
  | "stopped"
  | "syncing"
  | "waiting";
export type DaemonServiceStatus = "running" | "stopped";

export interface DaemonHeaderState {
  readonly status: DaemonServiceStatus;
  readonly phase: DaemonPhase;
  readonly nextSyncAt?: string;
}

export const DEFAULT_DAEMON_HEADER_STATE: DaemonHeaderState = {
  status: "stopped",
  phase: "stopped",
};

export const SCHEMA_MODELINE = "# yaml-language-server: $schema=./bookmarks.schema.json";
const DAEMON_HEADER_PREFIX = "# machine-managed: bookmarks daemon ";

const headerFieldOrder = ["status", "phase", "next_sync_at"] as const;

const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

const encodeHeaderFields = (state: DaemonHeaderState): string =>
  headerFieldOrder
    .flatMap((field) => {
      if (field === "status") return [`status=${state.status}`];
      if (field === "phase") return [`phase=${state.phase}`];
      return state.nextSyncAt ? [`next_sync_at=${state.nextSyncAt}`] : [];
    })
    .join("; ");

export const formatDaemonHeaderLine = (state: DaemonHeaderState): string =>
  `${DAEMON_HEADER_PREFIX}${encodeHeaderFields(state)}`;

export const parseDaemonHeaderLine = (line: string): DaemonHeaderState | undefined => {
  if (!line.startsWith(DAEMON_HEADER_PREFIX)) return undefined;

  const pairs = line
    .slice(DAEMON_HEADER_PREFIX.length)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf("=");
      return separator === -1
        ? undefined
        : ([part.slice(0, separator), part.slice(separator + 1)] as const);
    })
    .filter((part): part is readonly [string, string] => part !== undefined);

  const fields = Object.fromEntries(pairs);
  const status = fields["status"];
  const phase = fields["phase"];
  if ((status !== "running" && status !== "stopped") || !isDaemonPhase(phase)) {
    return undefined;
  }

  return {
    status,
    phase,
    ...(fields["next_sync_at"] ? { nextSyncAt: fields["next_sync_at"] } : {}),
  };
};

export const isDaemonPhase = (value: string | undefined): value is DaemonPhase =>
  value === "error" ||
  value === "idle" ||
  value === "queued" ||
  value === "starting" ||
  value === "stopped" ||
  value === "syncing" ||
  value === "waiting";

export const stripManagedConfigHeader = (raw: string): string => {
  const lines = raw.split("\n");
  let cursor = 0;

  if (lines[cursor]?.startsWith(DAEMON_HEADER_PREFIX)) cursor += 1;
  if (lines[cursor] === SCHEMA_MODELINE) cursor += 1;
  while (lines[cursor] === "") cursor += 1;

  return lines.slice(cursor).join("\n");
};

export const extractDaemonHeaderState = (raw: string): DaemonHeaderState | undefined => {
  const [firstLine] = raw.split("\n");
  return firstLine ? parseDaemonHeaderLine(firstLine) : undefined;
};

export const applyManagedConfigHeader = (raw: string, state: DaemonHeaderState): string => {
  const body = stripManagedConfigHeader(raw).replace(/^\n+/, "");
  const prologue = `${formatDaemonHeaderLine(state)}\n${SCHEMA_MODELINE}\n`;
  return body.length > 0 ? `${prologue}${body}` : prologue;
};

export const readDaemonHeaderState = async (
  path: string,
): Promise<DaemonHeaderState | undefined> => {
  try {
    const raw = await Fs.readFile(path, "utf-8");
    return extractDaemonHeaderState(raw);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
};

export const writeManagedConfigHeader = async (
  path: string,
  state: DaemonHeaderState,
): Promise<void> => {
  try {
    const raw = await Fs.readFile(path, "utf-8");
    const next = applyManagedConfigHeader(raw, state);
    if (next === raw) return;
    await Fs.writeFile(path, next, "utf-8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
};
