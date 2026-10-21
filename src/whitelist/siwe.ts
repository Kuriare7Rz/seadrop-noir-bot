import axios from 'axios';
import { request as httpsRequest } from 'https';
import { getAddress, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { openSeaAgentOpts } from '../mint/openseaAuth';
import { logger } from '../utils/logger';

/**
 * OpenSea server-side eligibility via SIWE + DropEligibilityQuery.
 *
 * OpenSea owns gated (allowlist/presale) drop lists server-side — there is no
 * on-chain list to read. The authoritative check is the same one the OpenSea
 * website itself makes: sign in with the wallet (EIP-4361, a login signature
 * only — never a transaction), then run the persisted DropEligibilityQuery
 * GraphQL call and read `isEligible` per stage.
 *
 * Ported from the vert WL checker (Python), which verified this flow live
 * against OpenSea. Two transport gotchas carry over:
 *  - The SIWE nonce endpoint rejects `Content-Length: 0` at Cloudflare, so
 *    the nonce request is a raw https call with a chunked, empty body and
 *    NO Content-Length header at all.
 *  - The GraphQL call reads the active wallet from the
 *    `connected-account-server-hint` cookie, not from the query variable.
 */

const PERSISTED_QUERY_HASH =
  'd893f026d731e8f14986921fa4229098e018289f6cc7683f8ee2dd83749dd95d';
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) seadrop-noir-bot/wl-checker';

export interface StageEligibility {
  stage: number | null;
  eligible: boolean;
}

export interface OpenSeaEligibility {
  status: 'eligible' | 'not' | 'unknown';
  detail: string;
  stages: StageEligibility[];
}

interface CachedSession {
  cookieHeader: string;
  savedAt: number;
}

const sessions = new Map<string, CachedSession>();

class SessionError extends Error {}

function requestNonce(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: 'opensea.io',
        path: '/__api/auth/siwe/nonce',
        method: 'POST',
        headers: { 'User-Agent': UA, 'Transfer-Encoding': 'chunked' },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`nonce http ${res.statusCode}: ${data.slice(0, 120)}`));
            return;
          }
          try {
            resolve(JSON.parse(data).nonce as string);
          } catch {
            reject(new Error('nonce response was not JSON'));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function siweLogin(
  address: Address,
  privateKey: `0x${string}`
): Promise<string> {
  const account = privateKeyToAccount(privateKey);
  const checksum = getAddress(address);
  if (account.address.toLowerCase() !== checksum.toLowerCase()) {
    throw new Error('private key does not match wallet address');
  }

  const nonce = await requestNonce();
  const issuedAt = new Date().toISOString();
  const statement =
    'Click to sign in and accept the OpenSea Terms of Service ' +
    '(https://opensea.io/tos) and Privacy Policy (https://opensea.io/privacy).';
  // Byte-exact EIP-4361 message, no trailing newline.
  const message =
    `opensea.io wants you to sign in with your Ethereum account:\n` +
    `${checksum}\n\n${statement}\n\n` +
    `URI: https://opensea.io/\nVersion: 1\nChain ID: 1\n` +
    `Nonce: ${nonce}\nIssued At: ${issuedAt}`;

  const signature = await account.signMessage({ message });

  const res = await axios.post(
    'https://opensea.io/__api/auth/siwe/verify',
    {
      message: {
        domain: 'opensea.io',
        address: checksum,
        statement,
        uri: 'https://opensea.io/',
        version: '1',
        chainId: '1',
        nonce,
        issuedAt,
        accountType: 'Ethereum',
      },
      signature,
      chainArch: 'EVM',
      connectorId: 'io.metamask',
    },
    {
      headers: { 'User-Agent': UA },
      timeout: 30_000,
      validateStatus: () => true,
      ...openSeaAgentOpts(),
    }
  );
  if (res.status !== 200) {
    throw new SessionError(`siwe verify http ${res.status}`);
  }
  const setCookie = (res.headers['set-cookie'] as string[] | undefined) ?? [];
  const jar = new Map<string, string>();
  for (const line of setCookie) {
    const pair = line.split(';')[0];
    const eq = pair?.indexOf('=') ?? -1;
    if (pair && eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  if (!jar.has('access_token')) {
    throw new SessionError('siwe verify returned no access_token cookie');
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function getSession(
  address: Address,
  privateKey: `0x${string}`
): Promise<string> {
  const key = address.toLowerCase();
  const cached = sessions.get(key);
  if (cached && Date.now() - cached.savedAt < SESSION_TTL_MS) {
    return cached.cookieHeader;
  }
  const cookieHeader = await siweLogin(address, privateKey);
  sessions.set(key, { cookieHeader, savedAt: Date.now() });
  return cookieHeader;
}

function findStages(node: unknown, out: StageEligibility[]): void {
  if (Array.isArray(node)) {
    for (const item of node) findStages(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if ('isEligible' in obj && 'stageIndex' in obj) {
      out.push({
        stage: typeof obj.stageIndex === 'number' ? obj.stageIndex : null,
        eligible: obj.isEligible === true,
      });
    }
    for (const value of Object.values(obj)) findStages(value, out);
  }
}

async function runEligibilityQuery(
  address: Address,
  slug: string,
  cookieHeader: string
): Promise<OpenSeaEligibility> {
  const res = await axios.post(
    'https://gql.opensea.io/graphql',
    {
      extensions: {
        persistedQuery: { sha256Hash: PERSISTED_QUERY_HASH, version: 1 },
      },
      operationName: 'DropEligibilityQuery',
      variables: { address, collectionSlug: slug },
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'x-app-id': 'os2-web',
        'x-graphql-operation-type': 'query',
        Accept: '*/*',
        Origin: 'https://opensea.io',
        Referer: 'https://opensea.io/',
        'User-Agent': UA,
        Cookie: `${cookieHeader}; connected-account-server-hint=${address}`,
      },
      timeout: 30_000,
      validateStatus: () => true,
      ...openSeaAgentOpts(),
    }
  );

  if (res.status === 401 || res.status === 403) {
    throw new SessionError(`eligibility http ${res.status}`);
  }
  if (res.status === 429) {
    return { status: 'unknown', detail: 'OpenSea rate limited (429)', stages: [] };
  }
  const body = res.data as { data?: unknown; errors?: unknown } | undefined;
  const errorsText = JSON.stringify(body?.errors ?? []);
  if (errorsText.includes('PersistedQueryNotFound')) {
    return {
      status: 'unknown',
      detail:
        'OpenSea rotated the eligibility query — PERSISTED_QUERY_HASH in src/whitelist/siwe.ts needs a refresh from a browser trace',
      stages: [],
    };
  }
  if (errorsText.includes('PERMISSION_DENIED')) {
    throw new SessionError('eligibility PERMISSION_DENIED');
  }
  const stages: StageEligibility[] = [];
  findStages(body?.data, stages);
  if (stages.length === 0) {
    return {
      status: 'unknown',
      detail: 'no drop stages found for this slug (not an OpenSea drop?)',
      stages: [],
    };
  }
  const ok = stages.some((s) => s.eligible);
  const detail = stages
    .map((s) => `stage ${s.stage ?? '?'}: ${s.eligible ? 'ELIGIBLE' : 'no'}`)
    .join(', ');
  return { status: ok ? 'eligible' : 'not', detail, stages };
}

/**
 * Authoritative gated-drop eligibility for one wallet. Logs in via SIWE on
 * first use (session cached ~6h), retries once with a fresh login when the
 * cached session is rejected.
 */
export async function checkOpenSeaEligibility(
  address: Address,
  privateKey: `0x${string}`,
  slug: string
): Promise<OpenSeaEligibility> {
  let cookie: string;
  try {
    cookie = await getSession(address, privateKey);
  } catch (err) {
    return {
      status: 'unknown',
      detail: `SIWE login failed: ${err instanceof Error ? err.message : 'unknown'}`,
      stages: [],
    };
  }

  try {
    return await runEligibilityQuery(address, slug, cookie);
  } catch (err) {
    if (!(err instanceof SessionError)) {
      return {
        status: 'unknown',
        detail: `eligibility query failed: ${err instanceof Error ? err.message : 'unknown'}`,
        stages: [],
      };
    }
    // Cached session rejected — drop it and retry once with a fresh login.
    sessions.delete(address.toLowerCase());
    logger.info(`[WL] SIWE session rejected for ${address}, re-login and retry`);
    try {
      const fresh = await getSession(address, privateKey);
      return await runEligibilityQuery(address, slug, fresh);
    } catch (retryErr) {
      return {
        status: 'unknown',
        detail: `eligibility failed after re-login: ${
          retryErr instanceof Error ? retryErr.message : 'unknown'
        }`,
        stages: [],
      };
    }
  }
}
