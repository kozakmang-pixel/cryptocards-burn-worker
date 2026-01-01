// ==============================
//  CRYPTOCARDS BURN WORKER
//  FULL NUKE VERSION (WITH DEBUG)
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
// DEBUG LOG — SHOW ENV KEY NAMES
// ==============================
console.log("========== ENV DEBUG ==========");
console.log(
  "ENV keys detected:",
  Object.keys(process.env).filter((k) =>
    ["BURN", "CRYPTO", "RPC", "PORT"].some((s) => k.includes(s))
  )
);
console.log("RAW BURN_WALLET_PUBLIC_KEY =", JSON.stringify(process.env.BURN_WALLET_PUBLIC_KEY));
console.log("================================");

// ==============================
// LOAD ENV CONFIG
// ==============================
const RPC_URL = process.env.RPC_URL;
const PORT = process.env.PORT || 4000;
const BURN_WALLET_PUBLIC_KEY = process.env.BURN_WALLET_PUBLIC_KEY;
const BURN_WALLET_SECRET_KEY = process.env.BURN_WALLET_SECRET_KEY;
const CRYPTOCARDS_MINT = process.env.CRYPTOCARDS_MINT;
const THRESHOLD_SOL = parseFloat(process.env.THRESHOLD_SOL);
const BURN_AUTH_TOKEN = process.env.BURN_AUTH_TOKEN;
const JUPITER_BASE_URL = process.env.JUPITER_BASE_URL;

// ==============================
// REQUIRED ENV CHECKS – DO NOT SKIP
// ==============================
function required(k, v) {
  if (!v || v.trim() === "") {
    console.error(`❌ Missing REQUIRED ENV VARIABLE: ${k}`);
    process.exit(1);
  }
}

required("RPC_URL", RPC_URL);
required("BURN_WALLET_PUBLIC_KEY", BURN_WALLET_PUBLIC_KEY);
required("BURN_WALLET_SECRET_KEY", BURN_WALLET_SECRET_KEY);
required("CRYPTOCARDS_MINT", CRYPTOCARDS_MINT);
required("BURN_AUTH_TOKEN", BURN_AUTH_TOKEN);

// ==============================
// CREATE SOLANA CONNECTION & WALLET
// ==============================
const connection = new Connection(RPC_URL, "confirmed");
const burnWalletPub = new PublicKey(BURN_WALLET_PUBLIC_KEY);
const mintPubkey = new PublicKey(CRYPTOCARDS_MINT);

let burnKeypair;
try {
  burnKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(BURN_WALLET_SECRET_KEY))
  );
} catch (err) {
  console.error("❌ FAILED TO PARSE SECRET KEY:", err.message);
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
console.log("====================================");

// ==============================
// AUTH MIDDLEWARE
// ==============================
function requireAuth(req, res, next) {
  const token = req.headers["x-burn-auth"];
  if (!token || token !== BURN_AUTH_TOKEN) {
    console.warn("⚠️ Unauthorized request");
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

// ==============================
// HEALTH CHECK
// ==============================
app.get("/health", async (req, res) => {
  const lamports = await connection.getBalance(burnWalletPub);
  res.json({
    ok: true,
    wallet: burnWalletPub.toBase58(),
    balanceSol: lamports / LAMPORTS_PER_SOL,
    rpc: RPC_URL,
    thresholdSol: THRESHOLD_SOL,
  });
});

// ==============================
// RUN BURN
// ==============================
app.post("/run-burn", requireAuth, async (req, res) => {
  try {
    console.log("🔥 /run-burn CALLED");

    const balanceLamports = await connection.getBalance(burnWalletPub);
    const balanceSol = balanceLamports / LAMPORTS_PER_SOL;

    console.log("Current SOL balance:", balanceSol, "| threshold:", THRESHOLD_SOL);

    if (balanceSol < THRESHOLD_SOL) {
      console.log("⏹ Below threshold – no burn.");
      return res.json({
        ok: false,
        reason: "below_threshold",
        balanceSol,
        thresholdSol: THRESHOLD_SOL,
      });
    }

    const MIN_SOL_REMAIN = 0.002;
    const lamportsAfterReserve =
      balanceLamports - MIN_SOL_REMAIN * LAMPORTS_PER_SOL;

    console.log("Lamports available to swap:", lamportsAfterReserve);

    const quoteUrl = `${JUPITER_BASE_URL}/v6/quote`;
    const quoteResp = await axios.get(quoteUrl, {
      params: {
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: mintPubkey.toBase58(),
        amount: lamportsAfterReserve,
        slippageBps: 150,
      },
      timeout: 15000,
    });

    const quote = quoteResp.data;
    if (!quote || !quote.outAmount) {
      console.log("❌ No Jupiter route found");
      return res.status(500).json({ ok: false, error: "jupiter_no_route" });
    }

    const swapResp = await axios.post(`${JUPITER_BASE_URL}/v6/swap`, {
      quoteResponse: quote,
      userPublicKey: burnWalletPub.toBase58(),
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: 5000
    });

    const swapTxBase64 = swapResp.data.swapTransaction;
    let tx = VersionedTransaction.deserialize(Buffer.from(swapTxBase64, "base64"));

    const { value: blockhashInfo } =
      await connection.getLatestBlockhashAndContext();
    tx.message.recentBlockhash = blockhashInfo.blockhash;
    tx.sign([burnKeypair]);

    const sig = await connection.sendTransaction(tx, {
      skipPreflight: true,
      preflightCommitment: "processed",
    });

    console.log("🚀 TX SENT:", sig);

    return res.json({ ok: true, signature: sig });
  } catch (err) {
    console.error("❌ ERROR DURING BURN:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================
// START SERVER
// ==============================
app.listen(PORT, () => {
  console.log(`🔥 CRYPTOCARDS Burn Worker Running on ${PORT}`);
});
