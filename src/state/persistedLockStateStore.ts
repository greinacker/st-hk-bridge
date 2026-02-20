import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Logger } from "pino";
import type { LockState } from "../types";

type PersistedLockState = Exclude<LockState, "unknown">;

interface PersistedLockStateRecord {
  state: PersistedLockState;
  updatedAt: string;
}

export interface PersistedLockStateStoreOptions {
  dataDir: string;
  logger: Pick<Logger, "debug" | "warn">;
  fileName?: string;
}

function isPersistedLockState(value: unknown): value is PersistedLockState {
  return value === "locked" || value === "unlocked";
}

export class PersistedLockStateStore {
  private readonly filePath: string;
  private readonly logger: Pick<Logger, "debug" | "warn">;

  constructor(options: PersistedLockStateStoreOptions) {
    const fileName = options.fileName ?? "lock-state.json";
    this.filePath = join(options.dataDir, fileName);
    this.logger = options.logger;
  }

  async load(): Promise<PersistedLockState | null> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      this.logger.warn({ err: error, filePath: this.filePath }, "Failed to read persisted lock state");
      return null;
    }

    try {
      const parsed = JSON.parse(content) as Partial<PersistedLockStateRecord> | null;
      if (parsed && isPersistedLockState(parsed.state)) {
        return parsed.state;
      }

      this.logger.warn({ filePath: this.filePath }, "Persisted lock state file is invalid and will be ignored");
      return null;
    } catch (error) {
      this.logger.warn(
        { err: error, filePath: this.filePath },
        "Failed to parse persisted lock state file; ignoring stale data"
      );
      return null;
    }
  }

  async save(state: LockState): Promise<void> {
    if (!isPersistedLockState(state)) {
      return;
    }

    const dirPath = dirname(this.filePath);
    await mkdir(dirPath, { recursive: true });

    const tempFilePath = `${this.filePath}.tmp`;
    const payload: PersistedLockStateRecord = {
      state,
      updatedAt: new Date().toISOString()
    };

    await writeFile(tempFilePath, JSON.stringify(payload), "utf8");
    await rename(tempFilePath, this.filePath);

    this.logger.debug({ state, filePath: this.filePath }, "Persisted latest known lock state");
  }
}
