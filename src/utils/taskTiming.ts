/** Compact clock notation; keep sub-second tasks distinguishable from a zero duration. */
export function formatTaskDuration(durationMs: number): string {
  const milliseconds = Math.max(0, Math.floor(durationMs));
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const paddedSeconds = String(seconds % 60).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${String(minutes % 60).padStart(2, '0')}:${paddedSeconds}`;
  }
  if (milliseconds < 1000) {
    return `0:00.${String(milliseconds).padStart(3, '0')}`;
  }
  return `${minutes}:${paddedSeconds}`;
}
