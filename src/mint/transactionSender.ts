import { createWalletClient, http, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getFastestRpcUrl, getRankedUrls } from '../rpc/client';
import { leaseNonce, hasNonce, releaseNonce } from './nonceManager';
import type { MintCalldata } from './calldataBuilder';
import type { GasEstimate } from './gasEstimator';

export interface SendTransactionResult {
  txHash: `0x${string}`;
}

export async function sendMintTransaction(
  calldata: MintCalldata,
  privateKey: `0x${string}`,
  gasEstimate: GasEstimate
): Promise<SendTransactionResult> {
  const account = privateKeyToAccount(privateKey);

  // Use the fastest currently-ranked RPC for broadcast (critical for snipes).
  const rpcUrl = getFastestRpcUrl();
  const walletClient = createWalletClient({
    account,
    chain: config.chain.chain,
    transport: http(rpcUrl),
  });

  logger.info(
    `[TX] Sending mint tx from ${account.address.slice(0, 8)}... value=${formatEther(calldata.value)} ${config.chain.symbol} on ${config.chain.label}`
  );

  const txHash = await walletClient.sendTransaction({
    to: calldata.to,
    data: calldata.data,
    value: calldata.value,
    gas: gasEstimate.gasLimit,
    maxFeePerGas: gasEstimate.maxFeePerGas,
    maxPriorityFeePerGas: gasEstimate.maxPriorityFeePerGas,
    type: 'eip1559',
  });

  logger.info(`[TX] Transaction broadcast: ${txHash}`);

  return { txHash };
}

/**
 * SNIPE parallel broadcast: sign the mint tx ONCE, then blast the identical
 * signed raw transaction to every ranked RPC simultaneously. Because the signed
 * payload is identical, every RPC yields the SAME tx hash — whichever endpoint
 * reaches the sequencer/mempool first wins, the rest are harmless duplicates.
 *
 * Falls back to single-RPC send when only one endpoint is available.
 */
export async function sendMintTransactionParallel(
  calldata: MintCalldata,
  privateKey: `0x${string}`,
  gasEstimate: GasEstimate
): Promise<SendTransactionResult> {
  const account = privateKeyToAccount(privateKey);
  const urls = getRankedUrls();

  // Single endpoint — no benefit to parallelizing.
  if (urls.length <= 1) {
    return sendMintTransaction(calldata, privateKey, gasEstimate);
  }

  // ---- Local assembly + signing (NO RPC round-trip on the hot path) ----
  // If the wallet's nonce was pre-armed during pre-arm, build and sign the tx
  // fully offline using the cached nonce + local chainId. This removes the
  // blocking prepareTransactionRequest() call (nonce + chainId fetch) that
  // otherwise runs at fire time — the single biggest latency cost in the
  // critical window (see MEMORY: never do RPC in the snipe hot path).
  let serializedTransaction: `0x${string}`;
  let leasedAddress: `0x${string}` | null = null;

  if (hasNonce(account.address)) {
    const { nonce, chainId } = leaseNonce(account.address);
    leasedAddress = account.address;
    try {
      serializedTransaction = await account.signTransaction({
        to: calldata.to,
        data: calldata.data,
        value: calldata.value,
        gas: gasEstimate.gasLimit,
        maxFeePerGas: gasEstimate.maxFeePerGas,
        maxPriorityFeePerGas: gasEstimate.maxPriorityFeePerGas,
        nonce,
        chainId,
        type: 'eip1559',
      });
      logger.info(`[TX] Locally signed (nonce=${nonce}, chainId=${chainId}) — no fire-time RPC prep`);
    } catch (err) {
      // Signing failed — return the leased nonce so it isn't burned.
      releaseNonce(account.address);
      throw err;
    }
  } else {
    // Fallback: nonce not pre-armed (e.g. window-guard path). Prepare against
    // the fastest RPC once, then still broadcast in parallel.
    logger.warn(`[TX] Nonce not pre-armed for ${account.address.slice(0, 8)}...; using RPC prepare fallback`);
    const primaryClient = createWalletClient({
      account,
      chain: config.chain.chain,
      transport: http(urls[0]!),
    });
    const request = await primaryClient.prepareTransactionRequest({
      to: calldata.to,
      data: calldata.data,
      value: calldata.value,
      gas: gasEstimate.gasLimit,
      maxFeePerGas: gasEstimate.maxFeePerGas,
      maxPriorityFeePerGas: gasEstimate.maxPriorityFeePerGas,
      type: 'eip1559',
    });
    serializedTransaction = await primaryClient.signTransaction(request);
  }

  logger.info(
    `[TX] Parallel broadcast from ${account.address.slice(0, 8)}... to ${urls.length} RPC(s) on ${config.chain.label}`
  );

  // Blast the identical signed tx to all RPCs at once; first success wins.
  const sends = urls.map((url) =>
    createWalletClient({ account, chain: config.chain.chain, transport: http(url) })
      .sendRawTransaction({ serializedTransaction })
      .then((hash) => {
        logger.info(`[TX] Accepted by ${url}: ${hash}`);
        return hash;
      })
      .catch((err) => {
        logger.warn(`[TX] RPC ${url} rejected: ${err instanceof Error ? err.message : 'unknown'}`);
        throw err;
      })
  );

  try {
    const txHash = (await Promise.any(sends)) as `0x${string}`;
    logger.info(`[TX] Parallel broadcast winner hash: ${txHash}`);
    return { txHash };
  } catch {
    // Every RPC rejected the raw tx. If we leased a nonce, roll it back so the
    // wallet can retry cleanly (the tx never entered any mempool).
    if (leasedAddress) releaseNonce(leasedAddress);
    throw new Error('All RPC endpoints rejected the transaction during parallel broadcast');
  }
}
