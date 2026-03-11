/**
 * Polymarket redeem: redeem winning conditional tokens for USDC via CTF contract.
 * When using Gnosis Safe (signature type 2), tokens are held by the proxy; we execute
 * redeem via Safe so the Safe is msg.sender (forked from polymarket-copytrading-bot-ts).
 */
import { ethers } from "ethers";
import { getContractConfig } from "@polymarket/clob-client";
import Safe from "@safe-global/protocol-kit";
import type { MetaTransactionData } from "@safe-global/types-kit";
import { OperationType } from "@safe-global/types-kit";
import {
  POLYMARKET_CHAIN_ID,
  POLYMARKET_PRIVATE_KEY,
  POLYMARKET_PROXY,
  RPC_URL,
} from "../core/config";

/** CTF position balance uses 6 decimals (USDC). */
const CTF_BALANCE_DECIMALS = 6;
import { getAllHoldings, clearMarketHoldings } from "./holdings";

const PROXY_WALLET_ADDRESS = POLYMARKET_PROXY || "0x0CE0f0B103a240340E014797E8d8d65846F5C89c";

const CTF_ABI = [
  {
    constant: false,
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "indexSets", type: "uint256[]" },
    ],
    name: "redeemPositions",
    outputs: [],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    constant: true,
    inputs: [
      { name: "", type: "bytes32" },
      { name: "", type: "uint256" },
    ],
    name: "payoutNumerators",
    outputs: [{ name: "", type: "uint256" }],
    payable: false,
    stateMutability: "view",
    type: "function",
  },
  {
    constant: true,
    inputs: [{ name: "", type: "bytes32" }],
    name: "payoutDenominator",
    outputs: [{ name: "", type: "uint256" }],
    payable: false,
    stateMutability: "view",
    type: "function",
  },
  {
    constant: true,
    inputs: [{ name: "conditionId", type: "bytes32" }],
    name: "getOutcomeSlotCount",
    outputs: [{ name: "", type: "uint256" }],
    payable: false,
    stateMutability: "view",
    type: "function",
  },
  {
    constant: true,
    inputs: [
      { name: "owner", type: "address" },
      { name: "id", type: "uint256" },
    ],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    payable: false,
    stateMutability: "view",
    type: "function",
  },
  {
    constant: true,
    inputs: [
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "indexSet", type: "uint256" },
    ],
    name: "getCollectionId",
    outputs: [{ name: "", type: "bytes32" }],
    payable: false,
    stateMutability: "view",
    type: "function",
  },
  {
    constant: true,
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "collectionId", type: "bytes32" },
    ],
    name: "getPositionId",
    outputs: [{ name: "", type: "uint256" }],
    payable: false,
    stateMutability: "pure",
    type: "function",
  },
];

const PARENT_COLLECTION_ID = "0x0000000000000000000000000000000000000000000000000000000000000000";

function conditionIdToBytes32(conditionId: string): string {
  if (conditionId.startsWith("0x")) {
    return ethers.utils.hexZeroPad(conditionId, 32);
  }
  const bn = ethers.BigNumber.from(conditionId);
  return ethers.utils.hexZeroPad(bn.toHexString(), 32);
}

async function getProvider(): Promise<ethers.providers.JsonRpcProvider> {
  const url = RPC_URL || "https://polygon-rpc.com";
  return new ethers.providers.JsonRpcProvider(url);
}

export interface CheckResolutionResult {
  isResolved: boolean;
  winningIndexSets: number[];
  reason?: string;
}

export async function checkConditionResolution(
  conditionId: string,
  chainId: number = POLYMARKET_CHAIN_ID
): Promise<CheckResolutionResult> {
  const contractConfig = getContractConfig(chainId);
  const provider = await getProvider();
  const wallet = new ethers.Wallet(
    POLYMARKET_PRIVATE_KEY.startsWith("0x") ? POLYMARKET_PRIVATE_KEY : `0x${POLYMARKET_PRIVATE_KEY}`,
    provider
  );
  const ctf = new ethers.Contract(contractConfig.conditionalTokens, CTF_ABI, wallet);
  const conditionIdBytes32 = conditionIdToBytes32(conditionId);

  try {
    const payoutDenominator = await ctf.payoutDenominator(conditionIdBytes32);
    const isResolved = !payoutDenominator.isZero();
    let winningIndexSets: number[] = [];
    if (isResolved) {
      const outcomeSlotCount = (await ctf.getOutcomeSlotCount(conditionIdBytes32)).toNumber();
      for (let i = 0; i < outcomeSlotCount; i++) {
        const num = await ctf.payoutNumerators(conditionIdBytes32, i);
        if (!num.isZero()) winningIndexSets.push(i + 1);
      }
    }
    return {
      isResolved,
      winningIndexSets,
      reason: isResolved
        ? `Winning indexSets: ${winningIndexSets.join(", ")}`
        : "Not resolved",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isResolved: false, winningIndexSets: [], reason: msg };
  }
}

async function getUserTokenBalances(
  conditionId: string,
  walletAddress: string,
  chainId: number
): Promise<Map<number, ethers.BigNumber>> {
  const contractConfig = getContractConfig(chainId);
  const provider = await getProvider();
  const wallet = new ethers.Wallet(
    POLYMARKET_PRIVATE_KEY.startsWith("0x") ? POLYMARKET_PRIVATE_KEY : `0x${POLYMARKET_PRIVATE_KEY}`,
    provider
  );
  const ctf = new ethers.Contract(contractConfig.conditionalTokens, CTF_ABI, wallet);
  const conditionIdBytes32 = conditionIdToBytes32(conditionId);
  const balances = new Map<number, ethers.BigNumber>();
  const outcomeSlotCount = (await ctf.getOutcomeSlotCount(conditionIdBytes32)).toNumber();

  for (let i = 1; i <= outcomeSlotCount; i++) {
    try {
      const collectionId = await ctf.getCollectionId(
        PARENT_COLLECTION_ID,
        conditionIdBytes32,
        i
      );
      const positionId = await ctf.getPositionId(contractConfig.collateral, collectionId);
      const balance = await ctf.balanceOf(walletAddress, positionId);
      if (!balance.isZero()) balances.set(i, balance);
    } catch {
      // skip
    }
  }
  return balances;
}

/**
 * Get proxy wallet token balance for one outcome (on-chain). Used to sell only what we hold.
 * outcomeIndex: 1 = first outcome (e.g. UP), 2 = second (e.g. DOWN) for binary.
 * Returns balance in human form (shares). Returns 0 if proxy not set or balance unavailable.
 */
export async function getProxyTokenBalanceHuman(
  conditionId: string,
  outcomeIndex: number,
  chainId: number = POLYMARKET_CHAIN_ID
): Promise<number> {
  if (!POLYMARKET_PROXY) return 0;
  const walletAddress = PROXY_WALLET_ADDRESS;
  const contractConfig = getContractConfig(chainId);
  const provider = await getProvider();
  const wallet = new ethers.Wallet(
    POLYMARKET_PRIVATE_KEY.startsWith("0x") ? POLYMARKET_PRIVATE_KEY : `0x${POLYMARKET_PRIVATE_KEY}`,
    provider
  );
  const ctf = new ethers.Contract(contractConfig.conditionalTokens, CTF_ABI, wallet);
  const conditionIdBytes32 = conditionIdToBytes32(conditionId);
  try {
    const collectionId = await ctf.getCollectionId(PARENT_COLLECTION_ID, conditionIdBytes32, outcomeIndex);
    const positionId = await ctf.getPositionId(contractConfig.collateral, collectionId);
    const balance = await ctf.balanceOf(walletAddress, positionId);
    const raw = balance.toString();
    const human = raw ? parseFloat(raw) / 10 ** CTF_BALANCE_DECIMALS : 0;
    return Number.isFinite(human) ? human : 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[getProxyTokenBalanceHuman] Failed:", msg, "conditionId:", conditionId.slice(0, 20) + "...", "outcomeIndex:", outcomeIndex);
    return 0;
  }
}

export async function redeemPositions(options: {
  conditionId: string;
  indexSets?: number[];
  chainId?: number;
}): Promise<ethers.providers.TransactionReceipt> {
  const chainId = options.chainId ?? POLYMARKET_CHAIN_ID;
  const contractConfig = getContractConfig(chainId);
  const provider = await getProvider();
  const wallet = new ethers.Wallet(
    POLYMARKET_PRIVATE_KEY.startsWith("0x") ? POLYMARKET_PRIVATE_KEY : `0x${POLYMARKET_PRIVATE_KEY}`,
    provider
  );
  const ctf = new ethers.Contract(contractConfig.conditionalTokens, CTF_ABI, wallet);
  const conditionIdBytes32 = conditionIdToBytes32(options.conditionId);
  const indexSets = options.indexSets ?? [1, 2];

  const tx = await ctf.redeemPositions(
    contractConfig.collateral,
    PARENT_COLLECTION_ID,
    conditionIdBytes32,
    indexSets,
    { gasLimit: 500_000 }
  );
  return tx.wait();
}

/**
 * Redeem via Gnosis Safe so the Safe (proxy) is msg.sender. Use when tokens are held by the proxy.
 */
async function redeemPositionsViaSafe(
  conditionId: string,
  indexSets: number[],
  chainId: number
): Promise<ethers.providers.TransactionReceipt> {
  const privateKey =
    POLYMARKET_PRIVATE_KEY.startsWith("0x") ? POLYMARKET_PRIVATE_KEY : `0x${POLYMARKET_PRIVATE_KEY}`;
  const contractConfig = getContractConfig(chainId);
  const rpcUrl = RPC_URL || "https://polygon-rpc.com";
  const conditionIdBytes32 = conditionIdToBytes32(conditionId);

  const ctf = new ethers.Contract(contractConfig.conditionalTokens, CTF_ABI);
  const data = ctf.interface.encodeFunctionData("redeemPositions", [
    contractConfig.collateral,
    PARENT_COLLECTION_ID,
    conditionIdBytes32,
    indexSets,
  ]);

  const metaTx: MetaTransactionData = {
    to: contractConfig.conditionalTokens,
    value: "0",
    data,
    operation: OperationType.Call,
  };

  const safeSdk = await Safe.init({
    provider: rpcUrl,
    signer: privateKey,
    safeAddress: PROXY_WALLET_ADDRESS,
  });

  const safeTransaction = await safeSdk.createTransaction({ transactions: [metaTx] });
  const signedTx = await safeSdk.signTransaction(safeTransaction);
  const result = await safeSdk.executeTransaction(signedTx);

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const receipt = await provider.waitForTransaction(result.hash, 1, 60_000);
  if (receipt && receipt.status === 0) {
    throw new Error("Transaction reverted on-chain. Check proxy holds winning tokens and conditionId/indexSets.");
  }
  return receipt as ethers.providers.TransactionReceipt;
}

/**
 * Check if market is resolved; returns isResolved and winningIndexSets (for auto-redeem script).
 */
export async function isMarketResolved(conditionId: string): Promise<{
  isResolved: boolean;
  winningIndexSets?: number[];
  reason?: string;
}> {
  const resolution = await checkConditionResolution(conditionId);
  return {
    isResolved: resolution.isResolved,
    winningIndexSets: resolution.winningIndexSets,
    reason: resolution.reason,
  };
}

export async function redeemMarket(
  conditionId: string,
  chainId: number = POLYMARKET_CHAIN_ID
): Promise<ethers.providers.TransactionReceipt> {
  const resolution = await checkConditionResolution(conditionId, chainId);
  if (!resolution.isResolved) {
    throw new Error(`Market not resolved: ${resolution.reason ?? "unknown"}`);
  }
  if (resolution.winningIndexSets.length === 0) {
    throw new Error("Resolved but no winning index sets");
  }

  const provider = await getProvider();
  const wallet = new ethers.Wallet(
    POLYMARKET_PRIVATE_KEY.startsWith("0x") ? POLYMARKET_PRIVATE_KEY : `0x${POLYMARKET_PRIVATE_KEY}`,
    provider
  );
  const eoaAddress = (await wallet.getAddress()).toLowerCase();
  const proxyAddress = (POLYMARKET_PROXY || "").toLowerCase();
  const useProxyRedeem = proxyAddress.length > 0 && eoaAddress !== proxyAddress;

  // When proxy is configured, tokens are held by the proxy: always check balance at proxy (match polymarket-copytrading-bot-ts).
  const balanceAddress = POLYMARKET_PROXY ? PROXY_WALLET_ADDRESS : (await wallet.getAddress());
  const balances = await getUserTokenBalances(conditionId, balanceAddress, chainId);
  const redeemableIndexSets = resolution.winningIndexSets.filter((i) => {
    const b = balances.get(i);
    return b && !b.isZero();
  });

  if (redeemableIndexSets.length === 0) {
    throw new Error(
      `You don't hold any winning tokens. You hold: ${[...balances.keys()].join(", ")}; winners: ${resolution.winningIndexSets.join(", ")}`
    );
  }

  if (useProxyRedeem) {
    return redeemPositionsViaSafe(conditionId, redeemableIndexSets, chainId);
  }
  return redeemPositions({ conditionId, indexSets: redeemableIndexSets, chainId });
}

export interface AutoRedeemResult {
  total: number;
  resolved: number;
  redeemed: number;
  failed: number;
  results: Array<{
    conditionId: string;
    isResolved: boolean;
    redeemed: boolean;
    error?: string;
  }>;
}

export async function autoRedeemResolvedMarkets(options: {
  clearHoldingsAfterRedeem?: boolean;
  dryRun?: boolean;
}): Promise<AutoRedeemResult> {
  const holdings = getAllHoldings();
  const conditionIds = Object.keys(holdings);
  const results: AutoRedeemResult["results"] = [];
  let redeemedCount = 0;

  for (const conditionId of conditionIds) {
    const resolution = await checkConditionResolution(conditionId);
    if (!resolution.isResolved) {
      results.push({ conditionId, isResolved: false, redeemed: false });
      continue;
    }
    results.push({ conditionId, isResolved: true, redeemed: false });
    if (options.dryRun) {
      console.log(`[DRY RUN] Would redeem: ${conditionId}`);
      continue;
    }
    try {
      await redeemMarket(conditionId);
      redeemedCount++;
      const r = results[results.length - 1];
      if (r) r.redeemed = true;
      console.log(`Redeemed: ${conditionId}`);
      if (options.clearHoldingsAfterRedeem) {
        clearMarketHoldings(conditionId);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const r = results[results.length - 1];
      if (r) r.error = msg;
      console.error(`Redeem failed for ${conditionId}:`, msg);
    }
  }

  return {
    total: conditionIds.length,
    resolved: results.filter((r) => r.isResolved).length,
    redeemed: redeemedCount,
    failed: results.filter((r) => r.isResolved && !r.redeemed && r.error).length,
    results,
  };
}
