import fs from 'fs';
import path from 'path';

/**
 * This function ensures that the folder of a file exists.
 * if it doesn't, it creates it.
 * @param filePath - The path of the file
 * @param options - Options
 * @param options.withNoFile - If true, the path is considered a folder with no file
 * @returns The path of the file
 */
export function ensureFolderInPath(filePath: string, options?: { withNoFile?: boolean }): string {
  let dir = path.dirname(filePath);
  if (options?.withNoFile) {
    dir = filePath;
  }

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return filePath;
}
