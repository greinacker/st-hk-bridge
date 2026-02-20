import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { PersistedLockStateStore } from "../src/state/persistedLockStateStore";

describe("PersistedLockStateStore", () => {
  const logger = pino({ level: "silent" });
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("returns null when no persisted state exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "st-hk-bridge-"));
    tempDirs.push(dir);

    const store = new PersistedLockStateStore({ dataDir: dir, logger });
    await expect(store.load()).resolves.toBeNull();
  });

  it("persists and restores locked/unlocked states", async () => {
    const dir = await mkdtemp(join(tmpdir(), "st-hk-bridge-"));
    tempDirs.push(dir);

    const store = new PersistedLockStateStore({ dataDir: dir, logger });
    await store.save("locked");
    await expect(store.load()).resolves.toBe("locked");

    await store.save("unlocked");
    await expect(store.load()).resolves.toBe("unlocked");
  });

  it("ignores invalid persisted files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "st-hk-bridge-"));
    tempDirs.push(dir);

    const filePath = join(dir, "lock-state.json");
    await writeFile(filePath, JSON.stringify({ state: "jammed" }), "utf8");

    const store = new PersistedLockStateStore({ dataDir: dir, logger });
    await expect(store.load()).resolves.toBeNull();
  });

  it("does not overwrite last known state with unknown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "st-hk-bridge-"));
    tempDirs.push(dir);

    const store = new PersistedLockStateStore({ dataDir: dir, logger });
    await store.save("locked");
    await store.save("unknown");

    const filePath = join(dir, "lock-state.json");
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as { state: string };
    expect(persisted.state).toBe("locked");
  });
});
