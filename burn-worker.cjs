// burn-worker.cjs
// CRYPTOCARDS Burn Worker - runs on Railway, does SOL -> $CRYPTOCARDS swaps via Jupiter v6

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const web3 = require('@solana/web3.js');

const app = express();
app.use(cors());
app.use(express.json());

// --- ENVIRONMENT CONFIG ------------------------------------------------------

const PORT = process.env.PORT || 4000;

// Solana RPC (mainnet)
const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Burn wallet public key (where SOL sits and where $CRYPTOCARDS ends up)
const BURN_WALLET =
  process.env.BURN_WALLET ||
  'A3mpAVduHM9QyRgH1NSZp5ANnbPr2Z5vkXtc8EgDaZBF';

// Burn wallet secret key (JSON array of 64 bytes)
const BURN_WALLET_SECRET = process.env.BURN_WALLET_SECRET || '';

// CRYPTOCARDS token mint
const CRYPTOCARDS_MINT =
  process.env.CRYPTOCARDS_MINT ||
  'AuxRtUDw7KhWZxbMcfqPoB1cLcvq44Sw83UHRd3Spump';

// SOL threshold before we attempt a swap
const BURN_THRESHOLD_SOL = Number(
  process.env.BURN_THRESHOLD_SOL || '0.02'
);

// Auth token for backend -> worker calls
const BURN_AUTH_TOKEN = process.env.BURN_AUTH_TOKEN || '';

// Optional Jupiter API key (if you ever get one)
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || null;

// Solana "native SOL" mint
const SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';

// --- BASIC CHECKS ------------------------------------------------------------

if (!BURN_WALLET_SECRET) {
  console.warn(
    '⚠️  BURN_WALLET_SECRET is missing - worker will NOT be able to sign swaps.'
  );
}

if (!BURN_AUTH_TOKEN) {
  console.warn(
    '⚠️  BURN_AUTH_TOKEN is missing - backend will not be able to call /run-burn securely.'
  );
}

// Solana connection
const connection = new web3.Connection(SOLANA_RPC_URL, 'confirmed');

// --- HELPERS -----------------------------------------------------------------

function getBurnKeypair() {
  if (!BURN_WALLET_SECRET) return null;

  try {
    const raw = JSON.parse(BURN_WALLET_SECRET);
    if (!Array.isArray(raw)) {
      console.error(
        'BURN_WALLET_SECRET must be a JSON array of numbers (64-byte secret key)'
      );
      return null;
    }

    const secretKey = Uint8Array.from(raw);
    const kp = web3.Keypair.fromSecretKey(secretKey);

    if (BURN_WALLET && kp.publicKey.toBase58() !== BURN_WALLET) {
      console.warn(
        'BURN_WALLET_SECRET pubkey does NOT match BURN_WALLET env:',
        'secret pubkey =',
        kp.publicKey.toBase58(),
        'BURN_WALLET =',
        BURN_WALLET
      );
    } else {
      console.log(
        '✅ Burn worker using wallet:',
        kp.publicKey.toBase58()
      );
    }

    return kp;
  } catch (err) {
    console.error('Failed to parse BURN_WALLET_SECRET JSON:', err);
    return null;
  }
}

// --- CORE SWAP LOGIC (JUPITER V6) -------------------------------------------

/**
 * Very important:
 *  - We leave a safety buffer for fees + rent.
 *  - Only swap ~70% of spendable SOL over a 0.01 SOL buffer.
 * This avoids "Transfer: insufficient lamports" simulation failures.
 */
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
    const burnKeypair = getBurnKeypair();

    if (!burnKeypair) {
      return {
        ok: false,
        error: 'missing_burn_wallet_secret',
      };
    }

    if (!burnKeypair.publicKey.equals(burnPubkey)) {
      return {
        ok: false,
        error: 'burn_wallet_secret_pubkey_mismatch',
        secretPubkey: burnKeypair.publicKey.toBase58(),
        burnWallet: BURN_WALLET,
      };
    }

    // 1) Get current SOL balance
    const lamports = await connection.getBalance(burnPubkey, 'confirmed');
    const solBalance = lamports / web3.LAMPORTS_PER_SOL;

    console.log(
      `[WORKER] Burn wallet balance = ${solBalance} SOL (${lamports} lamports)`
    );

    if (solBalance < BURN_THRESHOLD_SOL) {
      console.log(
        `[WORKER] Balance below threshold (${BURN_THRESHOLD_SOL} SOL), skipping swap.`
      );
      return {
        ok: false,
        error: 'below_threshold',
        burnWallet: BURN_WALLET,
        balanceSol: solBalance,
        thresholdSol: BURN_THRESHOLD_SOL,
      };
    }

    // 2) Decide how much SOL to swap (THIS IS THE SAFETY LOGIC)

    const LAMPORTS_PER_SOL = web3.LAMPORTS_PER_SOL;

    // Keep ~0.01 SOL in the wallet as a hard buffer
    const FEE_RENT_BUFFER_SOL = 0.01;
    const FEE_RENT_BUFFER_LAMPORTS = Math.floor(
      FEE_RENT_BUFFER_SOL * LAMPORTS_PER_SOL
    );

    // Only consider lamports above that buffer as "spendable"
    let spendableLamports = lamports - FEE_RENT_BUFFER_LAMPORTS;

    if (spendableLamports <= 0) {
      console.warn(
        '[WORKER] Not enough lamports after reserving fee/rent buffer.',
        {
          lamports,
          FEE_RENT_BUFFER_LAMPORTS,
        }
      );
      return {
        ok: false,
        error: 'insufficient_after_fee_buffer',
        lamports,
        feeRentBufferLamports: FEE_RENT_BUFFER_LAMPORTS,
      };
    }

    // From the spendable amount, only swap ~70%
    const SAFETY_FRACTION = 0.7;
    const swapLamports = Math.floor(
      spendableLamports * SAFETY_FRACTION
    );

    if (swapLamports <= 0) {
      console.warn(
        '[WORKER] swapLamports <= 0 after safety fraction',
        {
          lamports,
          spendableLamports,
          SAFETY_FRACTION,
        }
      );
      return {
        ok: false,
        error: 'insufficient_after_safety_fraction',
        lamports,
        spendableLamports,
        safetyFraction: SAFETY_FRACTION,
      };
    }

    const swapSol = swapLamports / LAMPORTS_PER_SOL;

    console.log(
      `[WORKER] Preparing to swap ~${swapSol.toFixed(
        6
      )} SOL (${swapLamports} lamports) from wallet ${burnPubkey.toBase58()}`
    );

    const fetch = (await import('node-fetch')).default;

    // 3) Get a quote from Jupiter v6
    const quoteUrl =
      `https://quote-api.jup.ag/v6/quote` +
      `?inputMint=${encodeURIComponent(SOL_MINT_ADDRESS)}` +
      `&outputMint=${encodeURIComponent(CRYPTOCARDS_MINT)}` +
      `&amount=${swapLamports.toString()}` +
      `&slippageBps=100`;

    console.log('[WORKER] GET', quoteUrl);

    const quoteRes = await fetch(quoteUrl);
    if (!quoteRes.ok) {
      const text = await quoteRes.text().catch(() => null);
      console.error(
        '[WORKER] Jupiter quote error, status =',
        quoteRes.status,
        'body =',
        text
      );
      return {
        ok: false,
        error: 'quote_http_error',
        status: quoteRes.status,
        body: text,
      };
    }

    const quoteResponse = await quoteRes.json();
    if (!quoteResponse) {
      console.error(
        '[WORKER] Invalid quoteResponse from Jupiter'
      );
      return {
        ok: false,
        error: 'invalid_quote_response',
      };
    }

    // 4) Build swap transaction via Jupiter v6 swap
    const swapBody = {
      quoteResponse,
      userPublicKey: burnPubkey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    };

    const headers = { 'Content-Type': 'application/json' };
    if (JUPITER_API_KEY) {
      headers['x-api-key'] = JUPITER_API_KEY;
    }

    console.log(
      '[WORKER] POST https://quote-api.jup.ag/v6/swap body=',
      JSON.stringify(swapBody)
    );

    const swapRes = await fetch(
      'https://quote-api.jup.ag/v6/swap',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(swapBody),
      }
    );

    if (!swapRes.ok) {
      const text = await swapRes.text().catch(() => null);
      console.error(
        '[WORKER] Jupiter swap build error, status =',
        swapRes.status,
        'body =',
        text
      );
      return {
        ok: false,
        error: 'swap_build_http_error',
        status: swapRes.status,
        body: text,
      };
    }

    const swapJson = await swapRes.json();
    const swapTransaction =
      swapJson.swapTransaction || swapJson.swapTransactionBase64;

    if (!swapTransaction) {
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

    // 5) Deserialize, sign, send and confirm

    const swapTxBuf = Buffer.from(swapTransaction, 'base64');
    const tx = web3.VersionedTransaction.deserialize(swapTxBuf);

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
        '[WORKER] sendRawTransaction threw:',
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
      // Still return ok with warning; on-chain might be fine.
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
    console.error('[WORKER] runBurnSwap unexpected error:', err);
    return {
      ok: false,
      error: 'exception',
      details: err?.message || String(err),
    };
  }
}

// --- ROUTES ------------------------------------------------------------------

// Simple health check used by backend /burnwalletstatus
app.get('/health', async (_req, res) => {
  try {
    const pubkey = new web3.PublicKey(BURN_WALLET);
    const lamports = await connection.getBalance(pubkey, 'confirmed');
    const solBalance = lamports / web3.LAMPORTS_PER_SOL;

    res.json({
      ok: true,
      wallet: BURN_WALLET,
      balanceSol: solBalance,
      rpc: SOLANA_RPC_URL,
      thresholdSol: BURN_THRESHOLD_SOL,
      jupiterBaseUrl: 'https://quote-api.jup.ag/v6',
    });
  } catch (err) {
    console.error('Error in /health:', err);
    res.status(500).json({
      ok: false,
      error: err?.message || 'health_error',
    });
  }
});

// Main entrypoint for backend
app.post('/run-burn', async (req, res) => {
  try {
    const authHeader =
      req.headers['x-burn-auth'] ||
      req.headers['X-Burn-Auth'];

    if (!BURN_AUTH_TOKEN) {
      return res.status(500).json({
        ok: false,
        error: 'worker_missing_auth_token',
      });
    }

    if (!authHeader || authHeader !== BURN_AUTH_TOKEN) {
      return res.status(401).json({
        ok: false,
        error: 'unauthorized',
      });
    }

    const result = await runBurnSwap();

    if (!result.ok) {
      return res
        .status(500)
        .json({ ok: false, ...result });
    }

    return res.json(result);
  } catch (err) {
    console.error('Error in /run-burn:', err);
    res.status(500).json({
      ok: false,
      error: err?.message || 'run_burn_exception',
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(
    `CRYPTOCARDS burn-worker listening on port ${PORT}, RPC=${SOLANA_RPC_URL}`
  );
});
