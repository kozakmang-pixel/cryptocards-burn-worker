// burn-worker.cjs
// CRYPTOCARDS Burn Worker - SOL -> $CRYPTOCARDS via Jupiter Metis API

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const web3 = require('@solana/web3.js');

// ---------------- ENV + CONFIG ----------------

const PORT = process.env.PORT || 4000;

// Solana RPC (mainnet)
const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Burn wallet (public)
const BURN_WALLET =
  (process.env.BURN_WALLET || 'A3mpAVduHM9QyRgH1NSZp5ANnbPr2Z5vkXtc8EgDaZBF').trim();

// Burn wallet secret (JSON array of 64 bytes)
const BURN_WALLET_SECRET = (process.env.BURN_WALLET_SECRET || '').trim();

// CRYPTOCARDS mint
const CRYPTOCARDS_MINT =
  (process.env.CRYPTOCARDS_MINT || 'AuxRtUDw7KhWZxbMcfqPoB1cLcvq44Sw83UHRd3Spump').trim();

// Burn threshold (in SOL)
const BURN_THRESHOLD_SOL = Number(
  (process.env.BURN_THRESHOLD_SOL || '0.02').trim()
);

// How much SOL to always keep in the wallet (fee & rent buffer)
const FEE_RESERVE_SOL = Number(
  (process.env.BURN_FEE_RESERVE_SOL || '0.01').trim()
);

// Fraction of spendable SOL to actually swap (safety margin)
const SAFETY_FRACTION = Number(
  (process.env.BURN_SAFETY_FRACTION || '0.85').trim()
);

// Backend → worker auth (IMPORTANT: trim to kill invisible spaces/newlines)
const BURN_AUTH_TOKEN = (process.env.BURN_AUTH_TOKEN || '').trim();

// Jupiter Metis Swap API base URL
//  - GET  {base}/quote
//  - POST {base}/swap
const JUPITER_BASE_URL = (
  process.env.JUPITER_BASE_URL || 'https://api.jup.ag/swap/v1'
).replace(/\/+$/, '');

const JUPITER_API_KEY = (process.env.JUPITER_API_KEY || '').trim();

// Native SOL "mint"
const SOL_MINT_ADDRESS =
  'So11111111111111111111111111111111111111112';

// ---------------- SOLANA CONNECTION ----------------

const connection = new web3.Connection(SOLANA_RPC_URL, 'confirmed');

// ---------------- HELPERS ----------------

function getBurnWalletKeypair() {
  if (!BURN_WALLET_SECRET) return null;

  try {
    const raw = JSON.parse(BURN_WALLET_SECRET);
    if (!Array.isArray(raw)) {
      console.error(
        '[WORKER] BURN_WALLET_SECRET must be a JSON array of numbers (64-byte secret key)'
      );
      return null;
    }

    const secretKey = Uint8Array.from(raw);
    const keypair = web3.Keypair.fromSecretKey(secretKey);

    if (BURN_WALLET && keypair.publicKey.toBase58() !== BURN_WALLET) {
      console.warn(
        '[WORKER] BURN_WALLET_SECRET pubkey does NOT match BURN_WALLET env',
        'secret pubkey =',
        keypair.publicKey.toBase58(),
        'env BURN_WALLET =',
        BURN_WALLET
      );
    } else {
      console.log(
        '✅ Burn worker using wallet:',
        keypair.publicKey.toBase58()
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

// ---------------- CORE SWAP LOGIC ----------------

async function runBurnSwap() {
  try {
    if (
      !BURN_WALLET ||
      !CRYPTOCARDS_MINT ||
      !Number.isFinite(BURN_THRESHOLD_SOL) ||
      BURN_THRESHOLD_SOL <= 0
    ) {
      return {
        ok: false,
        error: 'config_invalid',
        details: {
          BURN_WALLET,
          CRYPTOCARDS_MINT,
          BURN_THRESHOLD_SOL,
        },
      };
    }

    const burnPubkey = new web3.PublicKey(BURN_WALLET);
    const burnKeypair = getBurnWalletKeypair();

    if (!burnKeypair) {
      console.warn(
        '[WORKER] BURN_WALLET_SECRET is not configured or invalid; cannot sign swap.'
      );
      return {
        ok: false,
        error: 'no_burn_wallet_secret',
      };
    }

    if (!burnKeypair.publicKey.equals(burnPubkey)) {
      return {
        ok: false,
        error: 'secret_pubkey_mismatch',
        burnWallet: BURN_WALLET,
        secretPubkey: burnKeypair.publicKey.toBase58(),
      };
    }

    // 1) Get SOL balance
    const lamports = await connection.getBalance(burnPubkey, 'confirmed');
    const solBalance = lamports / web3.LAMPORTS_PER_SOL;

    console.log(
      `[WORKER] Burn wallet balance = ${solBalance} SOL (${lamports} lamports)`
    );

    if (solBalance < BURN_THRESHOLD_SOL) {
      return {
        ok: false,
        error: 'below_threshold',
        burnWallet: BURN_WALLET,
        balanceSol: solBalance,
        thresholdSol: BURN_THRESHOLD_SOL,
      };
    }

    // 2) Decide how much SOL to swap (safe mode)
    const feeReserveLamports = Math.floor(
      FEE_RESERVE_SOL * web3.LAMPORTS_PER_SOL
    );
    let spendableLamports = lamports - feeReserveLamports;

    if (spendableLamports <= 0) {
      console.warn(
        '[WORKER] Not enough SOL after reserving fee/rent buffer.',
        { lamports, feeReserveLamports }
      );
      return {
        ok: false,
        error: 'insufficient_after_fee_reserve',
        lamports,
        feeReserveLamports,
      };
    }

    const swapLamports = Math.floor(
      spendableLamports * SAFETY_FRACTION
    );
    if (swapLamports <= 0) {
      console.warn(
        '[WORKER] swapLamports <= 0 after safety fraction',
        { lamports, spendableLamports, SAFETY_FRACTION }
      );
      return {
        ok: false,
        error: 'insufficient_after_safety_margin',
        lamports,
        spendableLamports,
        feeReserveLamports,
        safetyFraction: SAFETY_FRACTION,
      };
    }

    const swapSol = swapLamports / web3.LAMPORTS_PER_SOL;

    console.log(
      `[WORKER] Preparing to swap ~${swapSol.toFixed(
        6
      )} SOL (${swapLamports} lamports) from wallet ${burnPubkey.toBase58()}`
    );

    // Lazy import node-fetch (ESM)
    const { default: fetch } = await import('node-fetch');

    // 3) Jupiter quote: GET {JUPITER_BASE_URL}/quote
    const quoteUrl =
      `${JUPITER_BASE_URL}/quote` +
      `?inputMint=${encodeURIComponent(SOL_MINT_ADDRESS)}` +
      `&outputMint=${encodeURIComponent(CRYPTOCARDS_MINT)}` +
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
      const bodyText = await quoteRes.text().catch(() => null);
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

    // 4) Build swap transaction: POST {JUPITER_BASE_URL}/swap
    const swapHeaders = {
      'Content-Type': 'application/json',
    };
    if (JUPITER_API_KEY) {
      swapHeaders['x-api-key'] = JUPITER_API_KEY;
    }

    const swapBody = {
      quoteResponse: quoteJson,
      userPublicKey: burnPubkey.toBase58(),
      wrapAndUnwrapSol: true,
    };

    const swapUrl = `${JUPITER_BASE_URL}/swap`;
    console.log('[WORKER] POST', swapUrl);

    const swapRes = await fetch(swapUrl, {
      method: 'POST',
      headers: swapHeaders,
      body: JSON.stringify(swapBody),
    });

    if (!swapRes.ok) {
      const bodyText = await swapRes.text().catch(() => null);
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
      swapJson.swapTransaction || swapJson.swapTransactionBase64;

    if (!swapTxBase64) {
      console.error(
        '[WORKER] Missing swapTransaction in Jupiter response',
        swapJson
      );
      return {
        ok: false,
        error: 'missing_swap_transaction',
        raw: swapJson,
      };
    }

    // 5) Deserialize, sign, send
    const txBuf = Buffer.from(swapTxBase64, 'base64');
    const tx = web3.VersionedTransaction.deserialize(txBuf);

    tx.sign([burnKeypair]);

    const rawTx = tx.serialize();

    let signature;
    try {
      signature = await connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
        maxRetries: 3,
      });
    } catch (sendErr) {
      console.error(
        '[WORKER] sendRawTransaction error:',
        sendErr
      );
      return {
        ok: false,
        error: 'send_failed',
        details: sendErr?.message || String(sendErr),
      };
    }

    try {
      const conf = await connection.confirmTransaction(
        signature,
        'confirmed'
      );
      console.log(
        '[WORKER] Swap confirmed:',
        signature,
        'confirmation =',
        JSON.stringify(conf)
      );
    } catch (confErr) {
      console.error(
        '[WORKER] confirmTransaction error:',
        confErr
      );
    }

    console.log(
      `[WORKER] SUCCESS: swapped ~${swapSol.toFixed(
        6
      )} SOL to $CRYPTOCARDS. tx = ${signature}`
    );

    return {
      ok: true,
      txSignature: signature,
      swappedSol: swapSol,
      burnWallet: BURN_WALLET,
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

// ---------------- EXPRESS ROUTES ----------------

const app = express();
app.use(cors());
app.use(express.json());

// Health
app.get('/health', async (_req, res) => {
  try {
    const pubkey = new web3.PublicKey(BURN_WALLET);
    const lamports = await connection.getBalance(pubkey, 'confirmed');
    const sol = lamports / web3.LAMPORTS_PER_SOL;
    const hasSecret = !!getBurnWalletKeypair();

    res.json({
      ok: true,
      wallet: pubkey.toBase58(),
      balanceSol: sol,
      rpc: SOLANA_RPC_URL,
      thresholdSol: BURN_THRESHOLD_SOL,
      jupiterBaseUrl: JUPITER_BASE_URL,
      hasSecret,
      hasAuthToken: !!BURN_AUTH_TOKEN,
      authTokenLength: BURN_AUTH_TOKEN.length,
    });
  } catch (err) {
    console.error('[WORKER] /health error:', err);
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
});

// Debug auth – DOES NOT reveal env token, just lengths + equality
app.get('/debug-auth', (req, res) => {
  const headerTokenRaw = req.headers['x-burn-auth'] || req.headers['X-Burn-Auth'] || '';
  const headerToken = String(headerTokenRaw).trim();

  res.json({
    hasEnvToken: !!BURN_AUTH_TOKEN,
    envLength: BURN_AUTH_TOKEN.length,
    headerToken,          // this is what YOU sent
    headerLength: headerToken.length,
    equal: headerToken === BURN_AUTH_TOKEN,
  });
});

// Protected burn endpoint
app.post('/run-burn', async (req, res) => {
  try {
    const headerTokenRaw =
      req.headers['x-burn-auth'] ||
      req.headers['X-Burn-Auth'] ||
      '';

    const headerToken = String(headerTokenRaw).trim();

    if (!BURN_AUTH_TOKEN) {
      return res.status(500).json({
        ok: false,
        error: 'worker_missing_auth_token',
      });
    }

    if (!headerToken || headerToken !== BURN_AUTH_TOKEN) {
      console.warn(
        '[WORKER] Unauthorized /run-burn:',
        {
          headerLength: headerToken.length,
          envLength: BURN_AUTH_TOKEN.length,
        }
      );
      return res.status(401).json({
        ok: false,
        error: 'unauthorized',
      });
    }

    const result = await runBurnSwap();
    const status = result.ok ? 200 : 500;
    res.status(status).json(result);
  } catch (err) {
    console.error('[WORKER] /run-burn error:', err);
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(
    `CRYPTOCARDS burn-worker listening on port ${PORT}, RPC=${SOLANA_RPC_URL}`
  );
  console.log(`JUPITER_BASE_URL = ${JUPITER_BASE_URL}`);
  if (!BURN_WALLET_SECRET) {
    console.warn(
      '⚠️  BURN_WALLET_SECRET is missing - worker will NOT be able to sign swaps.'
    );
  } else {
    getBurnWalletKeypair();
  }
  console.log(
    `[AUTH] BURN_AUTH_TOKEN present = ${!!BURN_AUTH_TOKEN}, length = ${BURN_AUTH_TOKEN.length}`
  );
});
