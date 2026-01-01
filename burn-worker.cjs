// burn-worker.cjs
// CRYPTOCARDS burn worker: health + /run-burn using Jupiter v6

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  Keypair,
  VersionedTransaction,
} = require("@solana/web3.js");

const app = express();
app.use(express.json());

// --- Load config from .env ---
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const PORT = process.env.PORT || 4000;
const BURN_WALLET_PUBLIC_KEY = process.env.BURN_WALLET_PUBLIC_KEY;
const BURN_WALLET_SECRET_KEY = process.env.BURN_WALLET_SECRET_KEY;
const CRYPTOCARDS_MINT = process.env.CRYPTOCARDS_MINT;
const THRESHOLD_SOL = parseFloat(process.env.THRESHOLD_SOL || "0.02");
const BURN_AUTH_TOKEN = process.env.BURN_AUTH_TOKEN;
const JUPITER_BASE_URL =
  process.env.JUPITER_BASE_URL || "https://quote-api.jup.ag";

// Basic sanity checks
if (!BURN_WALLET_PUBLIC_KEY) {
  console.error("❌ Missing BURN_WALLET_PUBLIC_KEY in .env");
  process.exit(1);
}
if (!BURN_WALLET_SECRET_KEY) {
  console.error("❌ Missing BURN_WALLET_SECRET_KEY in .env");
  process.exit(1);
}
if (!CRYPTOCARDS_MINT) {
  console.error("❌ Missing CRYPTOCARDS_MINT in .env");
  process.exit(1);
}
if (!BURN_AUTH_TOKEN) {
  console.error("❌ Missing BURN_AUTH_TOKEN in .env");
  process.exit(1);
}

// --- Setup Solana connection & wallet ---
const connection = new Connection(RPC_URL, "confirmed");
const burnWalletPubkey = new PublicKey(BURN_WALLET_PUBLIC_KEY);
const cryptocardsMintPubkey = new PublicKey(CRYPTOCARDS_MINT);

let burnWalletKeypair;
try {
  const secretArray = JSON.parse(BURN_WALLET_SECRET_KEY);
  const secretKey = Uint8Array.from(secretArray);
  burnWalletKeypair = Keypair.fromSecretKey(secretKey);

  if (burnWalletKeypair.publicKey.toBase58() !== BURN_WALLET_PUBLIC_KEY) {
    console.warn(
      "⚠️  WARNING: BURN_WALLET_PUBLIC_KEY does NOT match the secret key's public key."
    );
  }
} catch (err) {
  console.error("❌ Failed to parse BURN_WALLET_SECRET_KEY:", err.message);
  process.exit(1);
}

console.log("✅ Config loaded:");
console.log("  RPC_URL:", RPC_URL);
console.log("  PORT:", PORT);
console.log("  BURN_WALLET_PUBLIC_KEY:", burnWalletPubkey.toBase58());
console.log("  CRYPTOCARDS_MINT:", cryptocardsMintPubkey.toBase58());
console.log("  THRESHOLD_SOL:", THRESHOLD_SOL);

// --- Little helper: auth middleware ---
function requireAuth(req, res, next) {
  const token = req.headers["x-burn-auth"];
  if (!token || token !== BURN_AUTH_TOKEN) {
    console.warn("⚠️ Unauthorized /run-burn attempt");
    return res.status(401).json({
      ok: false,
      error: "unauthorized",
    });
  }
  next();
}

// --- Health check ---
// GET http://localhost:4000/health
app.get("/health", async (req, res) => {
  try {
    const balanceLamports = await connection.getBalance(burnWalletPubkey);
    const balanceSol = balanceLamports / LAMPORTS_PER_SOL;

    res.json({
      ok: true,
      wallet: burnWalletPubkey.toBase58(),
      balanceSol,
      rpc: RPC_URL,
      thresholdSol: THRESHOLD_SOL,
    });
  } catch (err) {
    console.error("Health check error:", err);
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

// --- run-burn endpoint ---
// POST http://localhost:4000/run-burn
// Headers: x-burn-auth: <BURN_AUTH_TOKEN>
app.post("/run-burn", requireAuth, async (req, res) => {
  console.log("🔥 /run-burn called");

  try {
    // 1) Check SOL balance
    const balanceLamports = await connection.getBalance(burnWalletPubkey);
    const balanceSol = balanceLamports / LAMPORTS_PER_SOL;

    console.log(
      `  Current SOL balance: ${balanceSol} (threshold: ${THRESHOLD_SOL})`
    );

    if (balanceSol < THRESHOLD_SOL) {
      console.log("  ➡️  Balance below threshold, not burning.");
      return res.json({
        ok: false,
        reason: "below_threshold",
        balanceSol,
        thresholdSol: THRESHOLD_SOL,
      });
    }

    // 2) Decide how much to swap (leave ~0.002 SOL for rent/fees)
    const MIN_SOL_REMAIN = 0.002;
    const reservedLamports = MIN_SOL_REMAIN * LAMPORTS_PER_SOL;
    let swapLamports = balanceLamports - reservedLamports;

    if (swapLamports <= 0) {
      console.log("  ➡️  Not enough SOL after reserving for fees.");
      return res.json({
        ok: false,
        reason: "not_enough_after_reserve",
        balanceSol,
        minSolRemain: MIN_SOL_REMAIN,
      });
    }

    // Optional override: allow specifying amountLamports in body (advanced)
    if (
      req.body &&
      typeof req.body.amountLamports === "number" &&
      req.body.amountLamports > 0 &&
      req.body.amountLamports < swapLamports
    ) {
      console.log(
        `  Overriding swap amount to ${req.body.amountLamports} lamports`
      );
      swapLamports = Math.floor(req.body.amountLamports);
    }

    console.log(
      `  🔁 Preparing swap of ${
        swapLamports / LAMPORTS_PER_SOL
      } SOL to CRYPTOCARDS...`
    );

    // 3) Ask Jupiter for a quote
    const quoteResp = await axios.get(`${JUPITER_BASE_URL}/v6/quote`, {
      params: {
        inputMint: "So11111111111111111111111111111111111111112", // SOL
        outputMint: cryptocardsMintPubkey.toBase58(), // CRYPTOCARDS
        amount: swapLamports, // in lamports
        slippageBps: 150, // 1.5% slippage
      },
    });

    const quote = quoteResp.data;
    if (!quote || !quote.outAmount) {
      console.error("❌ No route from Jupiter:", quote);
      return res.status(500).json({
        ok: false,
        error: "No route from Jupiter for SOL -> CRYPTOCARDS",
      });
    }

    console.log(
      `  ✅ Jupiter quote OK, outAmount ~${quote.outAmount} units of CRYPTOCARDS`
    );

    // 4) Ask Jupiter for the swap transaction
    const swapResp = await axios.post(`${JUPITER_BASE_URL}/v6/swap`, {
      quoteResponse: quote,
      userPublicKey: burnWalletPubkey.toBase58(),
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: 10000,
    });

    const { swapTransaction } = swapResp.data;
    if (!swapTransaction) {
      console.error("❌ No swapTransaction field in Jupiter response");
      return res.status(500).json({
        ok: false,
        error: "No swapTransaction from Jupiter",
        jupiterRaw: swapResp.data,
      });
    }

    console.log("  ✅ Got swapTransaction from Jupiter, deserializing...");

    // 5) Deserialize, update blockhash, sign, simulate, send
    const swapTxBuf = Buffer.from(swapTransaction, "base64");
    let tx = VersionedTransaction.deserialize(swapTxBuf);

    const { value: bhInfo } =
      await connection.getLatestBlockhashAndContext("finalized");
    tx.message.recentBlockhash = bhInfo.blockhash;

    // Sign with burn wallet
    tx.sign([burnWalletKeypair]);

    console.log("  🧪 Simulating transaction before sending...");
    const simulation = await connection.simulateTransaction(tx, {
      commitment: "processed",
    });
    if (simulation.value.err) {
      console.error(
        "❌ Simulation failed:",
        simulation.value.err,
        simulation.value.logs
      );
      return res.status(500).json({
        ok: false,
        error: "simulation_failed",
        simError: simulation.value.err,
        logs: simulation.value.logs,
      });
    }

    console.log("  ✅ Simulation passed, sending transaction...");
    const signature = await connection.sendTransaction(tx, {
      skipPreflight: true,
      preflightCommitment: "processed",
    });

    console.log(`  📨 Sent swap tx: ${signature}`);

    const confirmation = await connection.confirmTransaction(
      {
        signature,
        blockhash: bhInfo.blockhash,
        lastValidBlockHeight: bhInfo.lastValidBlockHeight,
      },
      "finalized"
    );

    console.log("  ✅ Swap confirmed");

    res.json({
      ok: true,
      signature,
      balanceSolBefore: balanceSol,
      swappedLamports: swapLamports,
      swappedSol: swapLamports / LAMPORTS_PER_SOL,
      jupiterOutAmount: quote.outAmount,
      routePlan: quote.routePlan?.map((p) => p.swapInfo?.label) ?? null,
    });
  } catch (err) {
    console.error(
      "❌ /run-burn error:",
      err.response?.data || err.message || err
    );
    res.status(500).json({
      ok: false,
      error: err.message || "run-burn_failed",
      jupiterError: err.response?.data,
    });
  }
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(
    `CRYPTOCARDS burn-worker listening on port ${PORT}, RPC=${RPC_URL}`
  );
  console.log(`Using burn wallet: ${burnWalletPubkey.toBase58()}`);
});
