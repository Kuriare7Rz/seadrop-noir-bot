import { getAddress } from 'viem';
import type { Address } from 'viem';
import { config } from '../config';

export type ParsedUrlType = 'slug' | 'contract';

export interface ParsedUrl {
  type: ParsedUrlType;
  slug?: string;
  contractAddress?: Address;
  raw: string;
}

const OPENSEA_COLLECTION_REGEX = /^https?:\/\/(www\.)?opensea\.io\/collection\/([a-zA-Z0-9_-]+)\/?$/;
// Accept any OpenSea chain slug in the assets path (ethereum, robinhood, ...).
const OPENSEA_ASSETS_REGEX = /^https?:\/\/(www\.)?opensea\.io\/assets\/([a-zA-Z0-9_-]+)\/(0x[a-fA-F0-9]{40})(?:\/\d+)?\/?$/;

export function parseOpenSeaUrl(raw: string): ParsedUrl {
  const trimmed = raw.trim();

  try {
    const url = new URL(trimmed);
    if (!['opensea.io', 'www.opensea.io'].includes(url.hostname)) {
      throw new Error('Invalid domain: only opensea.io URLs are supported');
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Invalid domain')) throw err;
    throw new Error('Invalid URL format');
  }

  const collectionMatch = OPENSEA_COLLECTION_REGEX.exec(trimmed);
  if (collectionMatch) {
    const slug = collectionMatch[2];
    if (!slug) throw new Error('Could not extract collection slug from URL');
    return { type: 'slug', slug, raw: trimmed };
  }

  const assetsMatch = OPENSEA_ASSETS_REGEX.exec(trimmed);
  if (assetsMatch) {
    const urlChainSlug = assetsMatch[2];
    const rawAddress = assetsMatch[3];
    if (!rawAddress) throw new Error('Could not extract contract address from URL');
    // Warn if the URL chain slug does not match the active mint chain.
    if (urlChainSlug && urlChainSlug !== config.chain.openSeaSlug) {
      throw new Error(
        `URL is for chain "${urlChainSlug}" but the bot is minting on "${config.chain.openSeaSlug}". ` +
        `Set MINT_CHAIN=${urlChainSlug} to mint on that chain.`
      );
    }
    // Checksum address (EIP-55) — viem will reject non-checksummed addresses
    let contractAddress: Address;
    try {
      contractAddress = getAddress(rawAddress);
    } catch {
      throw new Error(`Invalid contract address in URL: ${rawAddress}`);
    }
    return { type: 'contract', contractAddress, raw: trimmed };
  }

  throw new Error(
    'Unsupported OpenSea URL format. Use:\n' +
    '\u2022 https://opensea.io/collection/{slug}\n' +
    `\u2022 https://opensea.io/assets/${config.chain.openSeaSlug}/{contract}/{tokenId}`
  );
}
