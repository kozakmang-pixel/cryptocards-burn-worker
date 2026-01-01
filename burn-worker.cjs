// ==============================
//  CRYPTOCARDS BURN WORKER
//  Using Jupiter lite-api.jup.ag (Swap V1)
// ==============================

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

// ==============================
// ENV DEBUG
// ==============================
console.log("========== ENV DEBUG ==========");
console.log(
  "ENV keys detected:",
  Object.keys(process.env).filter((k) =>
    ["BURN", "CRYPTO", "RPC", "PORT", "JUPITER"].some((s) => k.includes(s))
  )
);
console.log(
  "RAW BURN_WALLET_PUBLIC_KEY =",
  JSON.stringify(process.env.BURN_WALLET_PUBLIC_KEY)
);
console.log(
  "RAW JUPITER_BASE_URL =",
  JSON.stringify(process.env.JUPITER_BASE_URL)
);
console.log("================================");

// ==============================
// LOAD ENV CONFIG
// ==============================
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const PORT = process.env.PORT || 4000;
const BURN_WALLET_PUBLIC_KEY = process.env.BURN_WALLET_PUBLIC_KEY;
const BURN_WALLET_SECRET_KEY = process.env.BURN_WALLET_SECRET_KEY;
const CRYPTOCARDS_MINT = process.env.CRYPTOCARDS_MINT;
const THRESHOLD_SOL = parseFloat(process.env.THRESHOLD_SOL || "0.02");
const BURN_AUTH_TOKEN = process.env.BURN_AUTH_TOKEN;

// Default to lite-api.jup.ag free endpoint
// Final quote URL:  <base>/quote
// Final swap URL:   <base>/swap
const JUPITER_BASE_URL =
  (process.env.JUPITER_BASE_URL &&
    process.env.JUPITER_BASE_URL.replace(/\/+$/, "")) ||
  "https://lite-api.jup.ag/swap/v1";

// ==============================
// ENV REQUIRED CHECKS
// ==============================
function required(name, value) {
  if (!value || value.toString().trim() === "") {
    console.error(`❌ Missing REQUIRED ENV VARIABLE: ${name}`);
    process.exit(1);
  }
}

required("RPC_URL", RPC_URL);
required("BURN_WALLET_PUBLIC_KEY", BURN_WALLET_PUBLIC_KEY);
required("BURN_WALLET_SECRET_KEY", BURN_WALLET_SECRET_KEY);
required("CRYPTOCARDS_MINT", CRYPTOCARDS_MINT);
required("BURN_AUTH_TOKEN", BURN_AUTH_TOKEN);

// ==============================
// SOLANA CONNECTION & WALLET
// ==============================
const connection = new Connection(RPC_URL, "confirmed");
const burnWalletPub = new PublicKey(BURN_WALLET_PUBLIC_KEY);
const mintPubkey = new PublicKey(CRYPTOCARDS_MINT);

let burnKeypair;
try {
  const secretArr = JSON.parse(BURN_WALLET_SECRET_KEY);
  burnKeypair = Keypair.fromSecretKey(Uint8Array.from(secretArr));

  if (burnKeypair.publicKey.toBase58() !== burnWalletPub.toBase58()) {
    console.warn(
      "⚠️ BURN_WALLET_PUBLIC_KEY does NOT match secret key public key"
    );
  }
} catch (err) {
  console.error("❌ FAILED TO PARSE BURN_WALLET_SECRET_KEY:", err.message);
  process.exit(1);
}

// ==============================
// STARTUP LOG
// ==============================
console.log("============== STARTUP ==============");
console.log("RPC_URL:", RPC_URL);
console.log("PORT:", PORT);
console.log("BURN_WALLET_PUBLIC_KEY:", burnWalletPub.toBase58());
console.log("CRYPTOCARDS_MINT:", mintPubkey.toBase58());
console.log("THRESHOLD_SOL:", THRESHOLD_SOL);
console.log("JUPITER_BASE_URL:", JUPITER_BASE_URL);
console.log("====================================");

// ==============================
// AUTH MIDDLEWARE
// ==============================
function requireAuth(req, res, next) {
  const token = req.headers["x-burn-auth"];
  if (!token || token !== BURN_AUTH_TOKEN) {
    console.warn("⚠️ Unauthorized request to /run-burn");
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

// ==============================
// HEALTH CHECK
// GET /health
// ==============================
app.get("/health", async (req, res) => {
  try {
    const lamports = await connection.getBalance(burnWalletPub);
    res.json({
      ok: true,
      wallet: burnWalletPub.toBase58(),
      balanceSol: lamports / LAMPORTS_PER_SOL,
      rpc: RPC_URL,
      thresholdSol: THRESHOLD_SOL,
      jupiterBaseUrl: JUPITER_BASE_URL,
    });
  } catch (err) {
    console.error("❌ /health error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================
// RUN BURN
// POST /run-burn
// ==============================
app.post("/run-burn", requireAuth, async (req, res) => {
  console.log("🔥 /run-burn CALLED");

  try {
    // 1) Balance check
    const balanceLamports = await connection.getBalance(burnWalletPub);
    const balanceSol = balanceLamports / LAMPORTS_PER_SOL;
    console.log(
      `  Current SOL balance: ${balanceSol} (threshold: ${THRESHOLD_SOL})`
    );

    if (balanceSol < THRESHOLD_SOL) {
      console.log("  ⏹ Below threshold, not swapping.");
      return res.json({
        ok: false,
        reason: "below_threshold",
        balanceSol,
        thresholdSol: THRESHOLD_SOL,
      });
    }

    // 2) Decide amount to swap (leave 0.002 SOL for rent/fees)
    const MIN_SOL_REMAIN = 0.002;
    const reserveLamports = MIN_SOL_REMAIN * LAMPORTS_PER_SOL;
    const swapLamports = balanceLamports - reserveLamports;

    if (swapLamports <= 0) {
      console.log("  ⏹ Not enough SOL after reserving for fees.");
      return res.json({
        ok: false,
        reason: "not_enough_after_reserve",
        balanceSol,
        minSolRemain: MIN_SOL_REMAIN,
      });
    }

    console.log(
      `  🔁 Attempting to swap ${swapLamports / LAMPORTS_PER_SOL} SOL -> CRYPTOCARDS`
    );

    // Optional manual amount override
    if (
      req.body &&
      typeof req.body.amountLamports === "number" &&
      req.body.amountLamports > 0 &&
      req.body.amountLamports < swapLamports
    ) {
      console.log(
        `  Overriding swap amount to ${req.body.amountLamports} lamports`
      );
    }

    // 3) Jupiter QUOTE – using lite-api.jup.ag/swap/v1/quote
    const quoteUrl = `${JUPITER_BASE_URL}/quote`;
    console.log("  ➡️  Requesting quote from:", quoteUrl);

    const quoteResp = await axios.get(quoteUrl, {
      params: {
        inputMint: "So11111111111111111111111111111111111111112", // SOL
        outputMint: mintPubkey.toBase58(), // CRYPTOCARDS
        amount: swapLamports, // in lamports
        slippageBps: 150,
      },
      timeout: 15000,
    });

    const quote = quoteResp.data;
    if (!quote || !quote.outAmount) {
      console.error("❌ Jupiter returned invalid quote:", quote);
      return res.status(500).json({
        ok: false,
        error: "jupiter_no_route",
        jupiterRaw: quote,
      });
    }

    console.log(
      `  ✅ Jupiter quote outAmount ~${quote.outAmount} CRYPTOCARDS units`
    );

    // 4) Jupiter SWAP – using lite-api.jup.ag/swap/v1/swap
    const swapUrl = `${JUPITER_BASE_URL}/swap`;
    console.log("  ➡️  Requesting swap transaction from:", swapUrl);

    const swapResp = await axios.post(
      swapUrl,
      {
        quoteResponse: quote,
        userPublicKey: burnWalletPub.toBase58(),
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: 10_000,
      },
      {
        timeout: 20000,
      }
    );

    const swapTxBase64 = swapResp.data.swapTransaction;
    if (!swapTxBase64) {
      console.error("❌ swapTransaction missing in Jupiter response:", swapResp.data);
      return res.status(500).json({
        ok: false,
        error: "no_swap_transaction",
        jupiterRaw: swapResp.data,
      });
    }

    console.log("  ✅ Received swapTransaction from Jupiter");

    // 5) Deserialize, sign, send
    const txBuf = Buffer.from(swapTxBase64, "base64");
    let tx = VersionedTransaction.deserialize(txBuf);

    const { value: bhInfo } =
      await connection.getLatestBlockhashAndContext("finalized");
    tx.message.recentBlockhash = bhInfo.blockhash;

    tx.sign([burnKeypair]);

    console.log("  🧪 Simulating transaction...");
    const sim = await connection.simulateTransaction(tx, {
      commitment: "processed",
    });
    if (sim.value.err) {
      console.error("❌ Simulation failed:", sim.value.err, sim.value.logs);
      return res.status(500).json({
        ok: false,
        error: "simulation_failed",
        simError: sim.value.err,
        logs: sim.value.logs,
      });
    }

    console.log("  ✅ Simulation OK, sending transaction...");
    const sig = await connection.sendTransaction(tx, {
      skipPreflight: true,
      preflightCommitment: "processed",
    });

    console.log("  📨 Sent transaction:", sig);

    await connection.confirmTransaction(
      {
        signature: sig,
        blockhash: bhInfo.blockhash,
        lastValidBlockHeight: bhInfo.lastValidBlockHeight,
      },
      "finalized"
    );

    console.log("  ✅ Swap confirmed on-chain");

    return res.json({
      ok: true,
      signature: sig,
      balanceSolBefore: balanceSol,
      swappedLamports: swapLamports,
      swappedSol: swapLamports / LAMPORTS_PER_SOL,
      jupiterOutAmount: quote.outAmount,
    });
  } catch (err) {
    console.error(
      "❌ ERROR DURING /run-burn:",
      err.code || err.message,
      err.response?.data || ""
    );
    return res.status(500).json({
      ok: false,
      error: err.message || "run-burn_failed",
      code: err.code || null,
      jupiterError: err.response?.data || null,
    });
  }
});

// ==============================
// START SERVER
// ==============================
app.listen(PORT, () => {
  console.log(`🔥 CRYPTOCARDS Burn Worker Running on port ${PORT}`);
});
