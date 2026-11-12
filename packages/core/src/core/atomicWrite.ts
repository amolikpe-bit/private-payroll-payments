/** Atomic UTF-8 file replacement: write a sibling temp file, then rename. */

import { randomBytes } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";

export interface AtomicWriteOptions {
  mode: number;
}

/**
 * Write `content` to a unique sibling temp file and rename it over `filePath`.
 * The caller owns directory creation, permissions, and error wrapping.
 */
export async function atomicWriteFile(
  filePath: string,
  content: string,
  options: AtomicWriteOptions,
): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(tempPath, content, {
      encoding: "utf8",
      mode: options.mode,
      flag: "wx",
    });
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
