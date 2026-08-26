export function formatDuration(milliseconds: number): string {
  // Treat negative and non-finite values as 0
  if (!isFinite(milliseconds) || milliseconds < 0) {
    milliseconds = 0;
  }

  const totalSeconds = Math.floor(milliseconds / 1000);

  if (totalSeconds < 1) {
    return '<1s';
  }

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}