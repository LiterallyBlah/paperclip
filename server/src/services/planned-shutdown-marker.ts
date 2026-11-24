import fs from "node:fs";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

/**
 * A planned shutdown (SIGTERM/SIGINT) records the stopping controller's boot
 * ID before it drains anything. If the process is killed before the drain
 * finalizes every run, the next boot can tell this boot's leftover `running`
 * rows apart from a true crash: they were interrupted by a planned restart,
 * not lost. A boot with no marker (an unplanned crash) keeps the process-loss
 * path unchanged.
 */
export const PLANNED_SHUTDOWN_MARKER_DIRNAME = "planned-shutdowns";
export const PLANNED_SHUTDOWN_MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type PlannedShutdownMarker = {
  version: 1;
  bootId: string;
  pid: number;
  signal: "SIGINT" | "SIGTERM";
  at: string;
};

const BOOT_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

export function resolvePlannedShutdownMarkerDir(homeDir?: string) {
  return path.join(resolvePaperclipInstanceRoot({ homeDir }), PLANNED_SHUTDOWN_MARKER_DIRNAME);
}

/** Synchronous on purpose: it must land before a SIGKILL can follow the signal. */
export function writePlannedShutdownMarker(
  input: { bootId: string; pid: number; signal: "SIGINT" | "SIGTERM"; at?: Date },
  homeDir?: string,
): string {
  if (!BOOT_ID_PATTERN.test(input.bootId)) throw new Error("invalid controller boot id");
  const dir = resolvePlannedShutdownMarkerDir(homeDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const marker: PlannedShutdownMarker = {
    version: 1,
    bootId: input.bootId,
    pid: input.pid,
    signal: input.signal,
    at: (input.at ?? new Date()).toISOString(),
  };
  const target = path.join(dir, `${input.bootId}.json`);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(marker), { mode: 0o600 });
  fs.renameSync(temp, target);
  return target;
}

function parseMarker(raw: string): PlannedShutdownMarker | null {
  try {
    const value = JSON.parse(raw) as Partial<PlannedShutdownMarker>;
    if (value?.version !== 1 || typeof value.bootId !== "string" || !BOOT_ID_PATTERN.test(value.bootId)) return null;
    if (typeof value.at !== "string" || Number.isNaN(Date.parse(value.at))) return null;
    if (value.signal !== "SIGINT" && value.signal !== "SIGTERM") return null;
    return value as PlannedShutdownMarker;
  } catch {
    return null;
  }
}

/** Boot IDs whose controller recorded a planned shutdown recently. Markers
 * older than the retention window are removed; unreadable ones are ignored. */
export function readPlannedShutdownMarkers(
  now = new Date(),
  homeDir?: string,
): Map<string, PlannedShutdownMarker> {
  const dir = resolvePlannedShutdownMarkerDir(homeDir);
  const markers = new Map<string, PlannedShutdownMarker>();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return markers;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    let marker: PlannedShutdownMarker | null = null;
    try {
      marker = parseMarker(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!marker || name !== `${marker.bootId}.json`) continue;
    if (now.getTime() - Date.parse(marker.at) > PLANNED_SHUTDOWN_MARKER_MAX_AGE_MS) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // A stale marker that cannot be removed is still ignored.
      }
      continue;
    }
    markers.set(marker.bootId, marker);
  }
  return markers;
}
