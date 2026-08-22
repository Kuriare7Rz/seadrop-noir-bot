import { formatEther, getAddress } from 'viem';
import PQueue from 'p-queue';
import { parseOpenSeaUrl } from './urlParser';
import { resolveCollection } from './collectionResolver';
import { detectActiveSeaDrop } from './seadropDetector';
import { readMintConfig } from './mintConfigReader';
import { buildMintCalldata } from './calldataBuilder';
import { estimateGas, preArmGas } from './gasEstimator';
import { sendMintTransaction, sendMintTransactionParallel } from './transactionSender';
import { monitorTransaction } from './txMonitor';
import { validateMint } from '../risk/validator';
import { walletPool } from '../wallet/pool';
import { updateJobStatus } from '../db/mintJobs';
import { logAction } from '../db/auditLogs';
import { getUserSettings } from '../db/users';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getLatestBaseFee, benchmarkAndRank } from '../rpc/client';
import { checkIfDrop, anyStageOpen, getNextOpeningStage, msUntilStageOpens, OpenSeaAuthError } from './dropDetector';
import { buildDropMintTransaction } from './dropMinter';

export interface WalletRange {
  /** 1-based index of the first wallet to use (inclusive) */
  from: number;
  /** 1-based index of the last wallet to use (inclusive) */
  to: number;
}

export interface MintJobInput {
  telegramId: string;
  url: string;
  jobId: string; // jobId created by mintCommand before queuing
  forceMaxQuantity?: boolean; // if true, mint up to maxTotalMintableByWallet
  /** When set, only wallets within this 1-based index range are eligible */
  walletRange?: WalletRange;
}

export interface MintEngineResult {
  jobId: string;
  status: 'CONFIRMED' | 'FAILED' | 'DROPPED' | 'CANCELLED';
  txHash?: string;
  tokenIds?: string[];
  gasUsedEth?: string;
  errorMessage?: string;
  collectionName?: string;
  /** When multi-wallet mint is used, this contains results per wallet */
  walletResults?: Array<{
    walletIndex: number;
    walletAddress: string;
    status: 'CONFIRMED' | 'FAILED' | 'DROPPED' | 'CANCELLED';
    txHash?: string;
    tokenIds?: string[];
    gasUsedEth?: string;
    errorMessage?: string;
  }>;
}

/**
 * Execute mint for a single wallet. Separated for multi-wallet loop support.
 */
async function executeSingleWalletMint(
  input: MintJobInput,
  collection: { collectionName: string; collectionSlug: string; contractAddress: string },
  contractAddress: `0x${string}`,
  walletIndex: number | null,
  onStatusUpdate?: (jobId: string, message: string) => Promise<void>
): Promise<Omit<MintEngineResult, 'jobId' | 'collectionName'>> {
  const { telegramId, jobId } = input;
  const userSettings = getUserSettings(telegramId, {
    max_mint_price_eth: config.mint.defaultMaxMintPriceEth,
    max_gas_eth: config.mint.defaultMaxGasEth,
    quantity: config.mint.defaultQuantity,
    priority_fee_gwei: config.mint.maxPriorityFeeGwei,
  });

  const fail = (reason: string) => ({
    status: 'FAILED' as const,
    errorMessage: reason,
  });

  // Check if collection is an OpenSea Drop
  let dropInfo;
  try {
    dropInfo = collection.collectionSlug ? await checkIfDrop(collection.collectionSlug) : null;
  } catch (err) {
    if (err instanceof OpenSeaAuthError) {
      // A dead/expired OpenSea key must fail loudly and actionably. Never fall
      // through to on-chain public-only detection here — that misreports
      // WL/presale drops as "Mint has not started yet" and drops stage/target.
      return fail(
        `OpenSea API key rejected (HTTP ${err.status}). Stages/eligibility can't be read, ` +
        `so the mint was aborted instead of firing blind. Fix: /api set <new_key> then /api test.`
      );
    }
    throw err;
  }

  // ===== SNIPE FAST-PATH (default ON for scheduled mints) =====
  // Goal: fire in the first second the WL/public window opens, ahead of other
  // bots. OpenSea /mint returns 422 before the window is live and only returns
  // the signed tx once a stage the wallet is eligible for is active. So we:
  //   1) pre-arm (wallet, private key, baseFee, gas params) BEFORE open,
  //   2) hammer /mint starting a hair before open until it returns 200,
  //   3) broadcast instantly with pre-armed gas (skip estimateGas RPC).
  if (config.mint.snipeEnabled && collection.collectionSlug && dropInfo) {
    const openStage = getNextOpeningStage(dropInfo);
    const alreadyOpen = anyStageOpen(dropInfo);
    const msToOpen = alreadyOpen ? 0 : msUntilStageOpens(openStage);
    const hammerWindowMs = config.mint.snipeMaxHammerSeconds * 1000;

    // Only engage snipe when a stage is open now, or opens within the hammer window.
    if (alreadyOpen || (openStage && msToOpen !== null && msToOpen > 0 && msToOpen <= hammerWindowMs + config.mint.snipeLeadMs)) {
      const snipeStage = alreadyOpen ? (dropInfo.active_stage ?? openStage) : openStage;
      logger.info(
        `[SNIPE] Engaging for ${collection.collectionSlug} — stage=${snipeStage?.stage_type ?? 'active'} ` +
        `open ${alreadyOpen ? 'NOW' : 'in ' + Math.round((msToOpen ?? 0) / 1000) + 's'}`
      );

      // --- Pre-arm: acquire wallet + key ---
      const wallet = walletIndex !== null
        ? walletPool.acquireWalletByIndex(walletIndex)
        : (input.walletRange
          ? walletPool.acquireWalletInRange(input.walletRange.from, input.walletRange.to)
          : walletPool.acquireWallet());
      if (!wallet) {
        return fail(`No available wallet${walletIndex !== null ? ` at index ${walletIndex}` : ''}`);
      }
      const snipeDesc = walletIndex !== null ? `wallet ${walletIndex} (${wallet.address.slice(0, 8)}...)` : wallet.address.slice(0, 8);
      const privateKey = walletPool.getPrivateKey(wallet.address);
      if (!privateKey) {
        walletPool.releaseWallet(wallet.address);
        return fail('Could not retrieve private key');
      }

      try {
        // Quantity from the target stage's max_per_wallet (known pre-open on the stage object).
        const stageMax = parseInt(snipeStage?.max_per_wallet ?? dropInfo.active_stage?.max_per_wallet ?? '1');
        const quantity = input.forceMaxQuantity
          ? (isNaN(stageMax) ? 1 : stageMax)
          : Math.min(userSettings.quantity, isNaN(stageMax) ? 1 : stageMax);

        // Pre-fetch baseFee and pre-build aggressive gas params (no estimateGas).
        let baseFee: bigint;
        try {
          baseFee = await getLatestBaseFee();
        } catch {
          baseFee = 0n;
        }
        const snipeGas = preArmGas(
          baseFee,
          userSettings.max_gas_eth,
          config.mint.snipePriorityFeeGwei,
          config.mint.snipeGasLimit,
          config.mint.snipeBaseFeeMultiplier
        );

        // Wait until just before the window opens (lead time).
        if (!alreadyOpen && msToOpen !== null && msToOpen > config.mint.snipeLeadMs) {
          const preWait = msToOpen - config.mint.snipeLeadMs;
          logger.info(`[SNIPE] Pre-armed for ${snipeDesc}. Waiting ${Math.round(preWait / 1000)}s until T-${config.mint.snipeLeadMs}ms`);
          await new Promise((r) => setTimeout(r, preWait));
        }

        // Auto RPC pre-check: benchmark + re-rank right before firing so the
        // fastest RPC is always used, without needing a manual /check_rpc.
        if (config.mint.snipeRpcPrecheck) {
          try {
            const ranked = await benchmarkAndRank();
            const fastest = ranked.find((r) => r.latencyMs !== null);
            if (fastest) {
              logger.info(`[SNIPE] RPC pre-check done — fastest: ${fastest.url} (${fastest.latencyMs}ms)`);
            } else if (ranked.length > 0) {
              logger.warn(`[SNIPE] RPC pre-check: all custom RPCs failed; using .env fallback`);
            }
          } catch (err) {
            logger.warn(`[SNIPE] RPC pre-check failed: ${err instanceof Error ? err.message : 'unknown'}`);
          }
        }

        // --- Hammer /mint until 200 + signature, then broadcast instantly ---
        logger.info(`[SNIPE] Hammering /mint for ${collection.collectionSlug} every ${config.mint.snipeHammerIntervalMs}ms (max ${config.mint.snipeMaxHammerSeconds}s)`);
        const hammerDeadline = Date.now() + hammerWindowMs;
        let attempts = 0;
        while (Date.now() < hammerDeadline) {
          attempts += 1;
          const r = await buildDropMintTransaction(collection.collectionSlug, wallet.address, quantity, walletIndex);

          if (r.success) {
            const { to, data, value } = r.data;
            const mintPriceWei = BigInt(value);
            const parsedMaxPrice = parseFloat(userSettings.max_mint_price_eth);
            const userMaxPriceWei = BigInt(Math.floor((isNaN(parsedMaxPrice) ? 0 : parsedMaxPrice) * 1e18));
            if (mintPriceWei > userMaxPriceWei) {
              walletPool.releaseWallet(wallet.address);
              return fail(`Mint price (${formatEther(mintPriceWei)} ETH) exceeds max (${userSettings.max_mint_price_eth} ETH)`);
            }
            const dropCalldata = { to, data, value: mintPriceWei };
            logger.info(`[SNIPE] HIT on attempt ${attempts} for ${snipeDesc} — broadcasting immediately`);
            let txHash: `0x${string}`;
            try {
              const sent = config.mint.snipeParallelBroadcast
                ? await sendMintTransactionParallel(dropCalldata, privateKey, snipeGas)
                : await sendMintTransaction(dropCalldata, privateKey, snipeGas);
              txHash = sent.txHash;
              logger.info(`[SNIPE] Tx sent for ${snipeDesc}: ${txHash}`);
            } catch (err) {
              walletPool.releaseWallet(wallet.address);
              return fail(err instanceof Error ? err.message : 'Failed to send transaction');
            }
            const monitorResult = await monitorTransaction(txHash, contractAddress);
            walletPool.releaseWallet(wallet.address);
            if (monitorResult.status === 'CONFIRMED') {
              return { status: 'CONFIRMED', txHash, tokenIds: monitorResult.tokenIds, gasUsedEth: monitorResult.gasUsedEth };
            }
            return {
              status: monitorResult.status,
              txHash,
              errorMessage: monitorResult.status === 'DROPPED' ? 'Transaction timed out' : 'Transaction reverted on-chain',
            };
          }

          // Not eligible / drop inactive yet — window likely not live on OpenSea's side. Keep hammering.
          if (r.error.code === 'NOT_ELIGIBLE' || r.error.code === 'DROP_INACTIVE') {
            const jitter = config.mint.hammerJitterMs > 0 ? Math.floor(Math.random() * config.mint.hammerJitterMs) : 0;
            await new Promise((res) => setTimeout(res, config.mint.snipeHammerIntervalMs + jitter));
            continue;
          }
          // Rate limited (429) — back off Retry-After (or configured base) + jitter, then keep trying.
          if (r.error.code === 'RATE_LIMITED') {
            const jitter = config.mint.hammerJitterMs > 0 ? Math.floor(Math.random() * config.mint.hammerJitterMs) : 0;
            const wait = (r.error.retryAfterMs ?? config.mint.rateLimitBackoffMs) + jitter;
            logger.warn(`[SNIPE] 429 for ${snipeDesc}; backing off ${wait}ms`);
            await new Promise((res) => setTimeout(res, wait));
            continue;
          }
          // Not found → abort snipe, fall through to normal path.
          if (r.error.code === 'NOT_FOUND') {
            logger.warn(`[SNIPE] Drop not found during hammer; aborting snipe for ${collection.collectionSlug}`);
            break;
          }
          // Server error → brief backoff, keep trying within window.
          await new Promise((res) => setTimeout(res, Math.max(config.mint.snipeHammerIntervalMs, 300)));
        }

        walletPool.releaseWallet(wallet.address);
        return fail(`Snipe timed out after ${config.mint.snipeMaxHammerSeconds}s (${attempts} attempts) waiting for eligible mint window to open.`);
      } catch (err) {
        walletPool.releaseWallet(wallet.address);
        throw err;
      }
    }
  }

  // ===== WINDOW GUARD (stage-agnostic) =====
  // OpenSea's /mint endpoint auto-selects the active stage the wallet is
  // eligible for (WL / presale / public). The guard must therefore only wait
  // for *some* stage to open — it must NOT force public. If no stage is open
  // yet but one opens soon, poll until any stage goes live, then fire.
  if (
    config.mint.windowGuardEnabled &&
    collection.collectionSlug &&
    dropInfo &&
    !anyStageOpen(dropInfo)
  ) {
    const nextStage = getNextOpeningStage(dropInfo);
    const waitMs = msUntilStageOpens(nextStage);
    if (nextStage && waitMs !== null && waitMs > 0) {
      const maxWaitMs = config.mint.windowGuardMaxWaitSeconds * 1000;
      if (waitMs > maxWaitMs) {
        return fail(
          `Next stage (${nextStage.label || nextStage.stage_type}) opens in ${Math.round(waitMs / 1000)}s, ` +
          `beyond max wait ${config.mint.windowGuardMaxWaitSeconds}s. Start: ${nextStage.start_time}. ` +
          `Reschedule closer to the window.`
        );
      }
      logger.info(
        `[WINDOW_GUARD] Next stage (${nextStage.stage_type}) for ${collection.collectionSlug} opens in ` +
        `${Math.round(waitMs / 1000)}s; polling every ${config.mint.windowGuardPollMs}ms until any stage is live ` +
        `(max ${config.mint.windowGuardMaxWaitSeconds}s)`
      );
      const deadline = Date.now() + maxWaitMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, config.mint.windowGuardPollMs));
        let refreshed = null;
        try {
          refreshed = collection.collectionSlug ? await checkIfDrop(collection.collectionSlug) : null;
        } catch (err) {
          if (err instanceof OpenSeaAuthError) {
            return fail(
              `OpenSea API key rejected (HTTP ${err.status}) mid-wait. Fix: /api set <new_key> then /api test.`
            );
          }
          throw err;
        }
        if (refreshed) dropInfo = refreshed;
        if (dropInfo && anyStageOpen(dropInfo)) {
          logger.info(`[WINDOW_GUARD] A stage for ${collection.collectionSlug} is now OPEN — firing mint`);
          break;
        }
      }
      if (!dropInfo || !anyStageOpen(dropInfo)) {
        return fail(
          `Window guard timed out after ${config.mint.windowGuardMaxWaitSeconds}s waiting for a stage to open.`
        );
      }
    }
  }

  if (dropInfo && dropInfo.is_minting) {
    // ===== OPENSEA DROPS API PATH =====
    logger.info(`[ENGINE] Using OpenSea Drops API for ${collection.collectionSlug}`);

    const wallet = walletIndex !== null
      ? walletPool.acquireWalletByIndex(walletIndex)
      : (input.walletRange
        ? walletPool.acquireWalletInRange(input.walletRange.from, input.walletRange.to)
        : walletPool.acquireWallet());

    if (!wallet) {
      return fail(`No available wallet${walletIndex !== null ? ` at index ${walletIndex}` : ''}`);
    }

    const walletDesc = walletIndex !== null ? `wallet ${walletIndex} (${wallet.address.slice(0, 8)}...)` : wallet.address.slice(0, 8);

    try {
      const quantity = input.forceMaxQuantity
        ? parseInt(dropInfo.active_stage?.max_per_wallet ?? '1')
        : Math.min(userSettings.quantity, parseInt(dropInfo.active_stage?.max_per_wallet ?? '1'));

      const mintTxResult = await buildDropMintTransaction(collection.collectionSlug, wallet.address, quantity, walletIndex);

      if (!mintTxResult.success) {
        if (mintTxResult.error.code === 'SERVER_ERROR') {
          logger.warn(`[ENGINE] OpenSea Drops API unavailable for ${walletDesc}, falling back`);
          walletPool.releaseWallet(wallet.address);
          // Fall through to manual detection
        } else {
          walletPool.releaseWallet(wallet.address);
          return fail(mintTxResult.error.message);
        }
      } else {
        const { to, data, value } = mintTxResult.data;
        const mintPriceWei = BigInt(value);
        const mintPriceEth = formatEther(mintPriceWei);
        const parsedMaxPrice = parseFloat(userSettings.max_mint_price_eth);
        const userMaxPriceWei = BigInt(Math.floor((isNaN(parsedMaxPrice) ? 0 : parsedMaxPrice) * 1e18));

        if (mintPriceWei > userMaxPriceWei) {
          walletPool.releaseWallet(wallet.address);
          return fail(`Mint price (${mintPriceEth} ETH) exceeds max (${userSettings.max_mint_price_eth} ETH)`);
        }

        const dropCalldata = { to, data, value: mintPriceWei };
        let gasEstimate;
        try {
          gasEstimate = await estimateGas(dropCalldata, wallet.address, userSettings.max_gas_eth, userSettings.priority_fee_gwei);
        } catch (err) {
          walletPool.releaseWallet(wallet.address);
          return fail(err instanceof Error ? err.message : 'Gas estimation failed');
        }

        const privateKey = walletPool.getPrivateKey(wallet.address);
        if (!privateKey) {
          walletPool.releaseWallet(wallet.address);
          return fail('Could not retrieve private key');
        }

        let txHash: `0x${string}`;
        try {
          const result = await sendMintTransaction(dropCalldata, privateKey, gasEstimate);
          txHash = result.txHash;
          logger.info(`[ENGINE] Tx sent for ${walletDesc}: ${txHash}`);
        } catch (err) {
          walletPool.releaseWallet(wallet.address);
          return fail(err instanceof Error ? err.message : 'Failed to send transaction');
        }

        const monitorResult = await monitorTransaction(txHash, contractAddress);
        walletPool.releaseWallet(wallet.address);

        if (monitorResult.status === 'CONFIRMED') {
          return {
            status: 'CONFIRMED',
            txHash,
            tokenIds: monitorResult.tokenIds,
            gasUsedEth: monitorResult.gasUsedEth,
          };
        } else {
          return {
            status: monitorResult.status,
            txHash,
            errorMessage: monitorResult.status === 'DROPPED'
              ? 'Transaction timed out'
              : 'Transaction reverted on-chain',
          };
        }
      }
    } catch (err) {
      walletPool.releaseWallet(wallet.address);
      throw err;
    }
  }

  // ===== FALLBACK: MANUAL SEADROP DETECTION =====
  logger.info(`[ENGINE] Using manual SeaDrop detection for ${contractAddress}`);

  const seaDropTarget = await detectActiveSeaDrop(contractAddress);
  if (!seaDropTarget) {
    return fail('Not a SeaDrop collection or no active public drop found');
  }

  const wallet = walletIndex !== null
    ? walletPool.acquireWalletByIndex(walletIndex)
    : (input.walletRange
      ? walletPool.acquireWalletInRange(input.walletRange.from, input.walletRange.to)
      : walletPool.acquireWallet());

  if (!wallet) {
    return fail(`No available wallet${walletIndex !== null ? ` at index ${walletIndex}` : ''}`);
  }

  const walletDesc = walletIndex !== null ? `wallet ${walletIndex} (${wallet.address.slice(0, 8)}...)` : wallet.address.slice(0, 8);

  try {
    const mintConfig = await readMintConfig(
      contractAddress,
      seaDropTarget.address,
      wallet.address,
      seaDropTarget.publicDrop
    );

    const now = BigInt(Math.floor(Date.now() / 1000));
    if (mintConfig.publicDrop.startTime > now) {
      walletPool.releaseWallet(wallet.address);
      return fail(`Mint has not started yet`);
    }
    if (mintConfig.publicDrop.endTime > 0n && mintConfig.publicDrop.endTime < now) {
      walletPool.releaseWallet(wallet.address);
      return fail('Mint has ended');
    }

    if (
      mintConfig.mintStats.maxSupply > 0n &&
      mintConfig.mintStats.currentTotalSupply >= mintConfig.mintStats.maxSupply
    ) {
      walletPool.releaseWallet(wallet.address);
      return fail('Mint supply is exhausted');
    }

    const remainingMints =
      mintConfig.publicDrop.maxTotalMintableByWallet -
      Number(mintConfig.mintStats.minterNumMinted);

    if (remainingMints <= 0) {
      walletPool.releaseWallet(wallet.address);
      return fail(`Wallet has reached max mint limit (${mintConfig.publicDrop.maxTotalMintableByWallet})`);
    }

    const quantity = input.forceMaxQuantity
      ? remainingMints
      : Math.min(userSettings.quantity, remainingMints);

    const mintPriceEth = formatEther(mintConfig.publicDrop.mintPrice);
    const parsedMaxPrice = parseFloat(userSettings.max_mint_price_eth);
    const userMaxPriceWei = BigInt(Math.floor((isNaN(parsedMaxPrice) ? 0 : parsedMaxPrice) * 1e18));
    if (mintConfig.publicDrop.mintPrice > userMaxPriceWei) {
      walletPool.releaseWallet(wallet.address);
      return fail(`Mint price (${mintPriceEth} ETH) exceeds max (${userSettings.max_mint_price_eth} ETH)`);
    }

    const calldata = buildMintCalldata(mintConfig, quantity, wallet.address);

    let gasEstimate;
    try {
      gasEstimate = await estimateGas(calldata, wallet.address, userSettings.max_gas_eth, userSettings.priority_fee_gwei);
    } catch (err) {
      walletPool.releaseWallet(wallet.address);
      return fail(err instanceof Error ? err.message : 'Gas estimation failed');
    }

    const privateKey = walletPool.getPrivateKey(wallet.address);
    if (!privateKey) {
      walletPool.releaseWallet(wallet.address);
      return fail('Could not retrieve private key');
    }

    let txHash: `0x${string}`;
    try {
      const result = await sendMintTransaction(calldata, privateKey, gasEstimate);
      txHash = result.txHash;
      logger.info(`[ENGINE] Tx sent for ${walletDesc}: ${txHash}`);
    } catch (err) {
      walletPool.releaseWallet(wallet.address);
      return fail(err instanceof Error ? err.message : 'Failed to send transaction');
    }

    const monitorResult = await monitorTransaction(txHash, contractAddress);
    walletPool.releaseWallet(wallet.address);

    if (monitorResult.status === 'CONFIRMED') {
      return {
        status: 'CONFIRMED',
        txHash,
        tokenIds: monitorResult.tokenIds,
        gasUsedEth: monitorResult.gasUsedEth,
      };
    } else {
      return {
        status: monitorResult.status,
        txHash,
        errorMessage: monitorResult.status === 'DROPPED'
          ? 'Transaction timed out'
          : 'Transaction reverted on-chain',
      };
    }
  } catch (err) {
    walletPool.releaseWallet(wallet.address);
    throw err;
  }
}

export async function runMintJob(
  input: MintJobInput,
  onStatusUpdate?: (jobId: string, message: string) => Promise<void>
): Promise<MintEngineResult> {
  const { telegramId, url, jobId } = input;

  logger.info(`[ENGINE] Starting mint job ${jobId} for user ${telegramId}`);
  logAction(telegramId, 'MINT_START', { jobId, url });

  const fail = async (reason: string): Promise<MintEngineResult> => {
    updateJobStatus(jobId, 'FAILED', { error_message: reason });
    logAction(telegramId, 'MINT_FAILED', { jobId, reason });
    logger.warn(`[ENGINE] Job ${jobId} failed: ${reason}`);
    return { jobId, status: 'FAILED', errorMessage: reason };
  };

  try {
    // Step 1: Parse URL
    let parsedUrl;
    try {
      parsedUrl = parseOpenSeaUrl(url);
    } catch (err) {
      return fail(err instanceof Error ? err.message : 'Invalid URL');
    }

    // Step 2: Resolve collection
    let collection;
    try {
      collection = await resolveCollection(parsedUrl);
    } catch (err) {
      return fail(err instanceof Error ? err.message : 'Failed to resolve collection');
    }

    // Checksum the contract address (EIP-55)
    let contractAddress;
    try {
      contractAddress = getAddress(collection.contractAddress);
    } catch {
      return fail(`Invalid contract address: ${collection.contractAddress}`);
    }

    updateJobStatus(jobId, 'PENDING', {
      collection_name: collection.collectionName,
      contract_address: contractAddress,
    });

    // Step 3: Risk validation (blacklist, etherscan, age, goplus)
    const validationError = await validateMint(contractAddress, telegramId);
    if (validationError) {
      return fail(validationError);
    }

    // ===== MULTI-WALLET CONCURRENT MINT =====
    if (input.walletRange) {
      const { from, to } = input.walletRange;
      const walletCount = to - from + 1;
      logger.info(`[ENGINE] Multi-wallet mint: executing ${walletCount} mints (wallets ${from}-${to}) with concurrency ${config.mint.multiWalletConcurrency}`);

      const walletResults: NonNullable<MintEngineResult['walletResults']> = [];
      const queue = new PQueue({ concurrency: config.mint.multiWalletConcurrency });
      let completedCount = 0;

      // Progress reporting interval
      const progressInterval = setInterval(() => {
        if (completedCount > 0 && completedCount < walletCount) {
          logger.info(`[ENGINE] Progress: ${completedCount}/${walletCount} wallets processed`);
        }
      }, config.mint.multiWalletProgressInterval * 1000);

      const tasks = [];
      for (let i = from; i <= to; i++) {
        const walletIndex = i;
        const task = queue.add(async () => {
          logger.info(`[ENGINE] Processing wallet ${walletIndex}/${to}`);

          try {
            const result = await executeSingleWalletMint(
              input,
              collection,
              contractAddress,
              walletIndex,
              onStatusUpdate
            );

            const wallet = walletPool.getWalletByIndex(walletIndex);
            const walletResult = {
              walletIndex,
              walletAddress: wallet?.address ?? 'unknown',
              status: result.status,
              txHash: result.txHash,
              tokenIds: result.tokenIds,
              gasUsedEth: result.gasUsedEth,
              errorMessage: result.errorMessage,
            };
            walletResults.push(walletResult);

            completedCount++;

            if (result.status === 'CONFIRMED') {
              logger.info(`[ENGINE] Wallet ${walletIndex} mint CONFIRMED: ${result.txHash}`);
            } else {
              logger.warn(`[ENGINE] Wallet ${walletIndex} mint ${result.status}: ${result.errorMessage}`);
            }

            return walletResult;
          } catch (err) {
            const wallet = walletPool.getWalletByIndex(walletIndex);
            const errorMsg = err instanceof Error ? err.message : 'Unknown error';
            logger.error(`[ENGINE] Wallet ${walletIndex} mint error: ${errorMsg}`);
            const walletResult = {
              walletIndex,
              walletAddress: wallet?.address ?? 'unknown',
              status: 'FAILED' as const,
              errorMessage: errorMsg,
            };
            walletResults.push(walletResult);
            completedCount++;
            return walletResult;
          }
        });
        tasks.push(task);
      }

      // Wait for all tasks to complete
      await Promise.all(tasks);
      clearInterval(progressInterval);

      logger.info(`[ENGINE] Multi-wallet mint complete: ${completedCount}/${walletCount} processed`);

      // Sort results by wallet index
      walletResults.sort((a, b) => a.walletIndex - b.walletIndex);

      // Aggregate results
      const successCount = walletResults.filter(r => r.status === 'CONFIRMED').length;
      const failedCount = walletResults.filter(r => r.status === 'FAILED').length;

      if (successCount > 0) {
        const firstSuccess = walletResults.find(r => r.status === 'CONFIRMED');
        updateJobStatus(jobId, 'CONFIRMED', {
          tx_hash: firstSuccess?.txHash,
          token_ids: walletResults.flatMap(r => r.tokenIds ?? []),
        });
        logAction(telegramId, 'MINT_CONFIRMED', { jobId, walletResults });
        return {
          jobId,
          status: 'CONFIRMED',
          txHash: firstSuccess?.txHash,
          tokenIds: walletResults.flatMap(r => r.tokenIds ?? []),
          collectionName: collection.collectionName,
          walletResults,
        };
      } else {
        updateJobStatus(jobId, 'FAILED', {
          error_message: `All ${walletCount} wallets failed to mint`,
        });
        return {
          jobId,
          status: 'FAILED',
          errorMessage: `All ${walletCount} wallets failed to mint`,
          collectionName: collection.collectionName,
          walletResults,
        };
      }
    }

    // ===== SINGLE-WALLET MINT (original behavior) =====
    updateJobStatus(jobId, 'PROCESSING');
    if (onStatusUpdate) {
      await onStatusUpdate(jobId, 'processing');
    }

    const result = await executeSingleWalletMint(
      input,
      collection,
      contractAddress,
      null,
      onStatusUpdate
    );

    if (result.status === 'CONFIRMED') {
      updateJobStatus(jobId, 'CONFIRMED', {
        tx_hash: result.txHash,
        token_ids: result.tokenIds,
        gas_used_eth: result.gasUsedEth,
      });
      logAction(telegramId, 'MINT_CONFIRMED', { jobId, txHash: result.txHash });
      return {
        jobId,
        status: 'CONFIRMED',
        txHash: result.txHash,
        tokenIds: result.tokenIds,
        gasUsedEth: result.gasUsedEth,
        collectionName: collection.collectionName,
      };
    } else {
      updateJobStatus(jobId, result.status, {
        tx_hash: result.txHash,
        error_message: result.errorMessage,
      });
      return {
        jobId,
        status: result.status,
        txHash: result.txHash,
        errorMessage: result.errorMessage,
        collectionName: collection.collectionName,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected error';
    return fail(message);
  }
}
