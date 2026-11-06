import * as semver from 'semver';

/**
 * Only discard a pending update when both versions are valid SemVer and its
 * target version is no newer than the installed version. Keep unrecognized
 * versions for the existing update flow instead of guessing their ordering.
 */
export function isPendingUpdateObsolete(
  pendingVersion: unknown,
  installedVersion: unknown,
): boolean {
  if (typeof pendingVersion !== 'string' || typeof installedVersion !== 'string') {
    return false;
  }

  const pending = semver.valid(pendingVersion.replace(/^v/i, ''));
  const installed = semver.valid(installedVersion.replace(/^v/i, ''));

  return pending !== null && installed !== null && semver.lte(pending, installed);
}
