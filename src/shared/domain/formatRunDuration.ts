/**
 * Format a duration in milliseconds into a human-readable string.
 *
 * @param milliseconds - The duration in milliseconds (can be negative or non-finite)
 * @returns A formatted string representing the duration.
 */
export function formatRunDuration(milliseconds: number): string {
  // Handle invalid numbers: treat as 0
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    milliseconds = 0;
  }

  const totalSeconds = Math.floor(milliseconds / 1000);

  if (totalSeconds < 1) {
    return '<1s';
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (hours > 0 || minutes > 0) {
    // Show minutes if we have hours or if minutes > 0
    // Actually, show minutes only if minutes > 0 (to match spec: 1h, 1h 5m, etc.)
    if (minutes > 0) {
      parts.push(`${minutes}m`);
    }
  }
  // Show seconds only if seconds > 0 (to omit zero seconds)
  if (seconds > 0) {
    parts.push(`${seconds}s`);
  }

  return parts.join(' ');
}