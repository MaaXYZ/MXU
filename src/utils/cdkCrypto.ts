import { decryptSecret, encryptSecret } from '@/utils/secretCrypto';

const BASE_KEY = 'MXU-CDK';
const GITHUB_PAT_BASE_KEY = 'MXU-GHPAT';

function buildKey(projectName?: string): string {
  return projectName ? `${BASE_KEY}-${projectName}` : BASE_KEY;
}

function buildGithubPatKey(projectName?: string): string {
  return projectName ? `${GITHUB_PAT_BASE_KEY}-${projectName}` : GITHUB_PAT_BASE_KEY;
}

export function encryptCdk(plaintext: string, projectName?: string): string {
  return encryptSecret(plaintext, buildKey(projectName));
}

export function decryptCdk(encrypted: string, projectName?: string): string {
  return decryptSecret(encrypted, buildKey(projectName));
}

// GitHub PAT 与 CDK 同为凭据，持久化时使用同一套混淆方案（独立密钥前缀，避免互相污染）。
export function encryptGithubPat(plaintext: string, projectName?: string): string {
  return encryptSecret(plaintext, buildGithubPatKey(projectName));
}

export function decryptGithubPat(encrypted: string, projectName?: string): string {
  return decryptSecret(encrypted, buildGithubPatKey(projectName));
}
