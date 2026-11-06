/** A stale connection must not clean up the instance now owned by a newer request. */
export class ControllerConnectionSupersededError extends Error {
  readonly code = 'CONTROLLER_CONNECTION_SUPERSEDED';

  constructor(message: string) {
    super(message);
    this.name = 'ControllerConnectionSupersededError';
  }
}
