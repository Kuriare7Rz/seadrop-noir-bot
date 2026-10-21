import type { WalletRange } from '../../mint/engine';

export interface PendingMint {
  code: string;
  telegramId: string;
  url: string;
  forceMaxQuantity: boolean;
  walletRange?: WalletRange;
  createdAt: number;
  expiresAt: number;
}

const pendingMints = new Map<string, PendingMint>();
const TTL_MS = 5 * 60 * 1000;

export function createPendingMint(input: Omit<PendingMint, 'code' | 'createdAt' | 'expiresAt'>): PendingMint {
  cleanupExpiredPendingMints();
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const now = Date.now();
  const pending: PendingMint = { ...input, code, createdAt: now, expiresAt: now + TTL_MS };
  pendingMints.set(`${input.telegramId}:${code}`, pending);
  return pending;
}

export function consumePendingMint(telegramId: string, code: string): PendingMint | null {
  cleanupExpiredPendingMints();
  const key = `${telegramId}:${code}`;
  const pending = pendingMints.get(key);
  if (!pending) return null;
  pendingMints.delete(key);
  return pending;
}

export function getPendingMintCount(telegramId?: string): number {
  cleanupExpiredPendingMints();
  if (!telegramId) return pendingMints.size;
  return Array.from(pendingMints.values()).filter((p) => p.telegramId === telegramId).length;
}

export function clearPendingMints(telegramId?: string): number {
  let count = 0;
  for (const [key, value] of pendingMints.entries()) {
    if (!telegramId || value.telegramId === telegramId) {
      pendingMints.delete(key);
      count++;
    }
  }
  return count;
}

function cleanupExpiredPendingMints(): void {
  const now = Date.now();
  for (const [key, value] of pendingMints.entries()) {
    if (value.expiresAt <= now) pendingMints.delete(key);
  }
}


export function cancelPendingMint(telegramId: string, code: string): boolean {
  cleanupExpiredPendingMints();
  return pendingMints.delete(`${telegramId}:${code}`);
}
