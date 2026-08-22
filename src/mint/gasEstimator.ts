import { formatEther } from 'viem';
import { publicClient, getLatestBaseFee, getMaxPriorityFeePerGas } from '../rpc/client';
import { config } from '../config';
import { logger } from '../utils/logger';
import type { Address } from 'viem';
import type { MintCalldata } from './calldataBuilder';

export interface GasEstimate {
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  totalGasCostWei: bigint;
  totalGasCostEth: string;
}

export async function estimateGas(
  calldata: MintCalldata,
  fromAddress: Address,
  userMaxGasEth: string,
  priorityFeeGwei?: number
): Promise<GasEstimate> {
  logger.info(`[GAS] Estimating gas for mint tx from ${fromAddress.slice(0, 8)}...`);

  // Fetch baseFee first so we can log it even if estimateGas throws
  const baseFee = await getLatestBaseFee();
  logger.info(`[GAS] Current baseFee: ${baseFee} wei (${Number(baseFee) / 1e9} gwei)`);

  const retryMs = Number(process.env.GAS_ESTIMATE_RETRY_MS || 45_000);
  const retryIntervalMs = Number(process.env.GAS_ESTIMATE_RETRY_INTERVAL_MS || 3_000);
  const deadline = Date.now() + retryMs;
  let rawEstimate: bigint | null = null;
  let attempt = 0;

  while (rawEstimate === null) {
    attempt += 1;
    try {
      rawEstimate = await publicClient.estimateGas({
        account: fromAddress,
        to: calldata.to,
        data: calldata.data,
        value: calldata.value,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const retryable = /execution reverted|reverted|drop inactive|not active|not started|not started yet/i.test(msg);
      if (!retryable || Date.now() >= deadline) throw err;
      logger.warn(`[GAS] estimateGas reverted on attempt ${attempt}; retrying in ${retryIntervalMs}ms (phase may not be active on latest block yet)`);
      await new Promise(resolve => setTimeout(resolve, retryIntervalMs));
    }
  }

  logger.info(`[GAS] Raw gas estimate: ${rawEstimate}`);

  // Apply 10% buffer (reduced from 20% to minimize gas cost)
  const gasLimit = (rawEstimate * 110n) / 100n;

  // Use network priority fee if no user override, fallback to config
  let maxPriorityFeePerGas: bigint;
  if (priorityFeeGwei !== undefined) {
    const effectivePriorityFeeGwei = Math.max(priorityFeeGwei, 0.05);
    if (priorityFeeGwei < 0.05) {
      logger.warn(`[GAS] Priority fee ${priorityFeeGwei} gwei is very low; bumping to safety minimum 0.05 gwei`);
    }
    maxPriorityFeePerGas = BigInt(Math.ceil(effectivePriorityFeeGwei * 1_000_000_000));
    logger.info(`[GAS] Using priority fee: ${effectivePriorityFeeGwei} gwei`);
  } else {
    try {
      maxPriorityFeePerGas = await getMaxPriorityFeePerGas();
      // Cap at config max to prevent extremely high fees
      const configMaxWei = BigInt(Math.ceil(config.mint.maxPriorityFeeGwei * 1_000_000_000));
      if (maxPriorityFeePerGas > configMaxWei) {
        logger.warn(`[GAS] Network priority fee too high, capping at ${config.mint.maxPriorityFeeGwei} gwei`);
        maxPriorityFeePerGas = configMaxWei;
      }
    } catch (error) {
      logger.warn(`[GAS] Using fallback priority fee: ${config.mint.maxPriorityFeeGwei} gwei`);
      maxPriorityFeePerGas = BigInt(Math.ceil(config.mint.maxPriorityFeeGwei * 1_000_000_000));
    }
  }

  // Safer EIP-1559 cap: 2x baseFee + priority. Actual paid gas remains market price,
  // but this avoids underpriced txs when baseFee moves before inclusion.
  const maxFeePerGas = (baseFee * 2n) + maxPriorityFeePerGas;

  const totalGasCostWei = gasLimit * maxFeePerGas;
  const totalGasCostEth = formatEther(totalGasCostWei);

  logger.info(
    `[GAS] maxFeePerGas: ${maxFeePerGas}, gasLimit: ${gasLimit}, total: ${totalGasCostEth} ETH`
  );

  // Check against user max gas setting
  const parsedMaxGas = parseFloat(userMaxGasEth);
  if (isNaN(parsedMaxGas) || parsedMaxGas <= 0) {
    throw new Error(`Invalid max gas setting: ${userMaxGasEth}`);
  }
  const userMaxGasWei = BigInt(Math.floor(parsedMaxGas * 1e18));
  if (totalGasCostWei > userMaxGasWei) {
    throw new Error(
      `Estimated gas cost (${totalGasCostEth} ETH) exceeds your max gas limit (${userMaxGasEth} ETH). ` +
      `Use /set_maxgas to increase the limit.`
    );
  }

  return {
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    totalGasCostWei,
    totalGasCostEth,
  };
}

/**
 * SNIPE FAST-PATH gas builder.
 *
 * Skips the blocking `publicClient.estimateGas` RPC roundtrip (200-500ms) that
 * the normal path does. Instead it uses a fixed gas limit and an aggressive
 * priority fee so the tx can be broadcast the instant the /mint signature is
 * obtained. Meant to be pre-warmed (baseFee fetched) BEFORE the window opens.
 *
 * @param baseFee            pre-fetched latest baseFee (wei)
 * @param userMaxGasEth      user max total gas cost (ETH) — still enforced
 * @param snipePriorityGwei  aggressive priority fee (gwei) for first-block inclusion
 * @param snipeGasLimit      fixed gas limit units (no estimate)
 * @param baseFeeMultiplier  headroom multiplier on baseFee for maxFeePerGas
 */
export function preArmGas(
  baseFee: bigint,
  userMaxGasEth: string,
  snipePriorityGwei: number,
  snipeGasLimit: bigint,
  baseFeeMultiplier: number = 3
): GasEstimate {
  const effPriorityGwei = Math.max(snipePriorityGwei, 0.05);
  const maxPriorityFeePerGas = BigInt(Math.ceil(effPriorityGwei * 1_000_000_000));

  const mult = BigInt(Math.max(2, Math.floor(baseFeeMultiplier)));
  const maxFeePerGas = baseFee * mult + maxPriorityFeePerGas;

  const gasLimit = snipeGasLimit;
  const totalGasCostWei = gasLimit * maxFeePerGas;
  const totalGasCostEth = formatEther(totalGasCostWei);

  logger.info(
    `[SNIPE_GAS] pre-armed: priority=${effPriorityGwei}gwei, maxFee=${maxFeePerGas}, ` +
    `gasLimit=${gasLimit}, worstCost=${totalGasCostEth} ETH`
  );

  const parsedMaxGas = parseFloat(userMaxGasEth);
  if (isNaN(parsedMaxGas) || parsedMaxGas <= 0) {
    throw new Error(`Invalid max gas setting: ${userMaxGasEth}`);
  }
  const userMaxGasWei = BigInt(Math.floor(parsedMaxGas * 1e18));
  if (totalGasCostWei > userMaxGasWei) {
    throw new Error(
      `Snipe worst-case gas cost (${totalGasCostEth} ETH) exceeds your max gas limit (${userMaxGasEth} ETH). ` +
      `Use /set_maxgas to increase, or lower SNIPE_PRIORITY_FEE_GWEI.`
    );
  }

  return { gasLimit, maxFeePerGas, maxPriorityFeePerGas, totalGasCostWei, totalGasCostEth };
}
