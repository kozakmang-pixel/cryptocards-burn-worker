// burn-worker.cjs
// CRYPTOCARDS burn worker - swaps SOL -> $CRYPTOCARDS using Jupiter Metis Swap API

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const web3 = require('@solana/web3.js');

// ----------- ENV + CONFIG -----------

const PORT = process.env.PORT || 4000;

// Solana RPC
const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Burn wallet (public + secret)
const BURN_WALLET_PUBLIC_KEY = process.env.BURN_WALLET_PUBLIC_KEY || '';
const BURN_WALLET_SECRET = process.env.BURN_WALLET_SECRET || '';

// CRYPTOCARDS mint (Pump.fun CA)
const CRYPTOCARDS_MINT =
  process.env.CRYPTOCARDS_MINT ||
  'AuxRtUDw7KhWZxbMcfqPoB1cLcvq44Sw83UHRd3Spump';

// Threshold in SOL before we trigger swap
const BURN_THRESHOLD_SOL = Number(
  process.env.BURN_THRESHOLD_SOL || '0.02'
);

// How much SOL to keep as fee buffer
const FEE_RESERVE_SOL = Number(
  process.env.BURN_FEE_RESERVE_SOL || '0.01'
);

// How much of the remaining balance to actually swap
const SAFETY_FRACTION = Number(
  process.env.BURN_SAFETY_FRACTION || '0.85'
);

// Simple auth between backend and worker
const BURN_WORKER_AUTH_TOKEN =
  process.env.BURN_WORKER_AUTH_TOKEN || '';

// Jupiter API
// Default to the public Metis Swap API base URL:
//   GET  {base}/quote
//   POST {base}/swap
const JUPITER_BASE_URL = (
  process.env.JUPITER_BASE_URL || 'https://api.jup.ag/swap/v1'
).replace(/\/+$/, '');

const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';

// Native SOL mint
const SOL_MINT_ADDRESS =
  'So11111111111111111111111111111111111111112';

// ----------- SOLANA CONNECTION -----------

const connection = new web3.Connection(
  SOLANA_RPC_URL,
  'confirmed'
);

// ----------- HELPERS -----------

function loadBurnWalletKeypair() {
  if (!BURN_WALLET_SECRET) return null;

  try {
    const raw = JSON.parse(BURN_WALLET_SECRET);
    if (!Array.isArray(raw)) {
      console.error(
        '[WORKER] BURN_WALLET_SECRET must be a JSON array (64-byte secret key)'
      );
      return null;
    }
    const secretKey = Uint8Array.from(raw);
    const keypair = web3.Keypair.fromSecretKey(secretKey);

    if (
      BURN_WALLET_PUBLIC_KEY &&
      keypair.publicKey.toBase58() !== BURN_WALLET_PUBLIC_KEY
    ) {
      console.warn(
        '[WORKER] BURN_WALLET_SECRET pubkey does NOT match BURN_WALLET_PUBLIC_KEY env'
      );
    }

    return keypair;
  } catch (err) {
    console.error(
      '[WORKER] Failed to parse BURN_WALLET_SECRET JSON:',
      err
    );
    return null;
  }
}

// Core swap logic
async function runBurnSwap() {
  try {
    if (!BURN_WALLET_PUBLIC_KEY) {
      return {
        ok: false,
        error: 'missing_burn_wallet',
      };
    }

    const burnPubkey = new web3.PublicKey(
      BURN_WALLET_PUBLIC_KEY
    );
    const burnKeypair = loadBurnWalletKeypair();

    if (!burnKeypair) {
      console.warn(
        '[WORKER] BURN_WALLET_SECRET missing or invalid; cannot sign swap.'
      );
      return {
        ok: false,
        error: 'no_burn_wallet_secret',
      };
    }

    // Check balance
    const lamports = await connection.getBalance(
      burnPubkey,
      'confirmed'
    );
    const solBalance =
      lamports / web3.LAMPORTS_PER_SOL;

    console.log(
      `[WORKER] Burn wallet balance = ${solBalance} SOL (${lamports} lamports)`
    );

    if (solBalance < BURN_THRESHOLD_SOL) {
      return {
        ok: false,
        error: 'below_threshold',
        solBalance,
        thresholdSol: BURN_THRESHOLD_SOL,
      };
    }

    // Compute how much to swap
    const feeReserveLamports = Math.floor(
      FEE_RESERVE_SOL * web3.LAMPORTS_PER_SOL
    );
    let spendableLamports =
      lamports - feeReserveLamports;

    if (spendableLamports <= 0) {
      return {
        ok: false,
        error: 'insufficient_after_fee_reserve',
        lamports,
        feeReserveLamports,
      };
    }

    let swapLamports = Math.floor(
      spendableLamports * SAFETY_FRACTION
    );

    if (swapLamports <= 0) {
      return {
        ok: false,
        error: 'insufficient_after_safety_margin',
        lamports,
        spendableLamports,
        feeReserveLamports,
        safetyFraction: SAFETY_FRACTION,
      };
    }

    const swapSol =
      swapLamports / web3.LAMPORTS_PER_SOL;

    console.log(
      `[WORKER] Preparing to swap ~${swapSol} SOL (${swapLamports} lamports) from wallet ${burnPubkey.toBase58()}`
    );

    // Lazy-import node-fetch (ESM)
    const { default: fetch } = await import(
      'node-fetch'
    );

    // 1) Get quote from Jupiter Metis Swap API
    const quoteUrl =
      `${JUPITER_BASE_URL}/quote?` +
      `inputMint=${encodeURIComponent(
        SOL_MINT_ADDRESS
      )}` +
      `&outputMint=${encodeURIComponent(
        CRYPTOCARDS_MINT
      )}` +
      `&amount=${swapLamports}` +
      `&slippageBps=100`;

    const quoteHeaders = {};
    if (JUPITER_API_KEY) {
      quoteHeaders['x-api-key'] = JUPITER_API_KEY;
    }

    console.log('[WORKER] GET', quoteUrl);

    const quoteRes = await fetch(quoteUrl, {
      method: 'GET',
      headers: quoteHeaders,
    });

    if (!quoteRes.ok) {
      const bodyText = await quoteRes.text();
      console.error(
        '[WORKER] Jupiter quote HTTP error:',
        quoteRes.status,
        bodyText
      );
      return {
        ok: false,
        error: 'jupiter_http_error',
        step: 'quote',
        status: quoteRes.status,
        body: bodyText,
      };
    }

    const quoteJson = await quoteRes.json();

    // 2) Build swap transaction using Jupiter Metis Swap API
    const swapHeaders = {
      'Content-Type': 'application/json',
    };
    if (JUPITER_API_KEY) {
      swapHeaders['x-api-key'] = JUPITER_API_KEY;
    }

    const swapBody = {
      quoteResponse: quoteJson,
      userPublicKey: burnPubkey.toBase64
        ? burnPubkey.toBase64()
        : burnPubkey.toBase58(),
      wrapAndUnwrapSol: true,
      // Extra safety options could go here if needed
    };

    const swapUrl = `${JUPITER_BASE_URL}/swap`;
    console.log('[WORKER] POST', swapUrl);

    const swapRes = await fetch(swapUrl, {
      method: 'POST',
      headers: swapHeaders,
      body: JSON.stringify(swapBody),
    });

    if (!swapRes.ok) {
      const bodyText = await swapRes.text();
      console.error(
        '[WORKER] Jupiter swap HTTP error:',
        swapRes.status,
        bodyText
      );
      return {
        ok: false,
        error: 'jupiter_http_error',
        step: 'swap_build',
        status: swapRes.status,
        body: bodyText,
      };
    }

    const swapJson = await swapRes.json();
    const swapTxBase64 =
      swapJson.swapTransaction ||
      swapJson.swapTransactionBase64;

    if (!swapTxBase64) {
      console.error(
        '[WORKER] Missing swapTransaction in Jupiter response'
      );
      return {
        ok: false,
        error: 'missing_swap_transaction',
        raw: swapJson,
      };
    }

    // 3) Deserialize, sign, and send
    const txBuf = Buffer.from(
      swapTxBase64,
      'base64'
    );
    const tx =
      web3.VersionedTransaction.deserialize(
        txBuf
      );

    tx.sign([burnKeypair]);

    const rawTx = tx.serialize();
    const sig =
      await connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
        maxRetries: 3,
      });

    await connection.confirmTransaction(sig, 'confirmed');

    console.log(
      `[WORKER] Burn swap executed: ${swapSol} SOL -> $CRYPTOCARDS, tx = ${sig}`
    );

    return {
      ok: true,
      tx: sig,
      swappedSol: swapSol,
      solBalanceBefore: solBalance,
      thresholdSol: BURN_THRESHOLD_SOL,
    };
  } catch (err) {
    console.error(
      '[WORKER] runBurnSwap unexpected error:',
      err
    );
    return {
      ok: false,
      error: 'exception',
      details: err?.message || String(err),
    };
  }
}

// ----------- EXPRESS APP -----------

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', async (_req, res) => {
  try {
    if (!BURN_WALLET_PUBLIC_KEY) {
      return res.status(500).json({
        ok: false,
        error:
          'Missing BURN_WALLET_PUBLIC_KEY in env',
      });
    }

    const pubkey = new web3.PublicKey(
      BURN_WALLET_PUBLIC_KEY
    );
    const lamports = await connection.getBalance(
      pubkey,
      'confirmed'
    );
    const sol = lamports / web3.LAMPORTS_PER_SOL;

    const keypair = loadBurnWalletKeypair();

    res.json({
      ok: true,
      wallet: pubkey.toBase58(),
      balanceSol: sol,
      rpc: SOLANA_RPC_URL,
      thresholdSol: BURN_THRESHOLD_SOL,
      jupiterBaseUrl: JUPITER_BASE_URL,
      hasSecret: !!keypair,
    });
  } catch (err) {
    console.error(
      '[WORKER] /health error:',
      err
    );
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
});

// Manual trigger (protected)
app.post('/run-burn', async (req, res) => {
  try {
    const headerToken =
      req.headers['x-burn-auth'];

    if (
      !BURN_WORKER_AUTH_TOKEN ||
      headerToken !== BURN_WORKER_AUTH_TOKEN
    ) {
      return res.status(401).json({
        ok: false,
        error: 'unauthorized',
      });
    }

    const result = await runBurnSwap();
    const status = result.ok ? 200 : 500;
    res.status(status).json(result);
  } catch (err) {
    console.error(
      '[WORKER] /run-burn error:',
      err
    );
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `CRYPTOCARDS burn-worker listening on port ${PORT}, RPC=${SOLANA_RPC_URL}`
  );
  console.log(
    `JUPITER_BASE_URL = ${JUPITER_BASE_URL}`
  );
  if (!BURN_WALLET_SECRET) {
    console.warn(
      '⚠️  BURN_WALLET_SECRET is missing - worker will NOT be able to sign swaps.'
    );
  } else {
    const kp = loadBurnWalletKeypair();
    if (kp) {
      console.log(
        '✅ Burn worker using wallet:',
        kp.publicKey.toBase58()
      );
    }
  }
});
