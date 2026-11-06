let provider: () => string[] = () => [];
const explicitSecrets = new Set<string>();

export function setLogSecretProvider(next: () => string[]): void {
  provider = next;
}

export function getLogSecrets(extra: string[] = []): string[] {
  for (const secret of [...provider(), ...extra]) if (secret) explicitSecrets.add(secret);
  return [...explicitSecrets];
}

export function redactLogText(text: string): string {
  const variants = getLogSecrets()
    .flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)])
    .sort((a, b) => b.length - a.length);
  for (const secret of variants) text = text.split(secret).join('******');
  return text;
}

export function redactLogValue(value: unknown): unknown {
  if (value instanceof Error) return redactLogText(value.stack ?? value.message);
  if (typeof value === 'string') return redactLogText(value);
  if (value && typeof value === 'object') {
    try {
      return redactLogText(JSON.stringify(value));
    } catch {
      return '[unserializable]';
    }
  }
  return value;
}
