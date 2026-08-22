import { createWalletClient, http, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getFastestRpcUrl, getRankedUrls } from '../rpc/client';
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

  // Prepare + sign once against the fastest RPC (needs nonce/chainId).
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
  const serializedTransaction = await primaryClient.signTransaction(request);

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
    // Every RPC rejected the raw tx.
    throw new Error('All RPC endpoints rejected the transaction during parallel broadcast');
  }
}
