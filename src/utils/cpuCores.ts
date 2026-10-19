import os from 'os';

/**
 * Returns the number of available CPU cores, leaving a buffer for the OS.
 * @param buffer Number of cores to leave for the OS (default: 1)
 */
export function getAvailableCpuCores(buffer: number = 0): { maxCores: number; minCores: number } {
  const totalCores = os.cpus().length;
  const maxCores = Math.max(1, totalCores - buffer);
  const minCores = totalCores < 3 ? 1 : Math.max(1, Math.floor(totalCores / 2));
  return {
    maxCores,
    minCores,
  };
}
