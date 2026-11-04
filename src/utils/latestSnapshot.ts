/** Keep an older, slower state request from replacing a newer successful snapshot. */
export function createSnapshotLoader() {
  let nextRequest = 0;
  let lastCompletedRequest = 0;

  return async function loadSnapshot<T>(load: () => Promise<T>): Promise<T | null> {
    const request = ++nextRequest;
    const snapshot = await load();
    if (request < lastCompletedRequest) return null;
    lastCompletedRequest = request;
    return snapshot;
  };
}
