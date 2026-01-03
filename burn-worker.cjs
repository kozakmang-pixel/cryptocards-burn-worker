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
  (process.env.BURN_FEE_RESERVE_SOL || '0').trim()
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

// SPL Token program IDs
const TOKEN_PROGRAM_ID = new web3.PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
);
const TOKEN_2022_PROGRAM_ID = new web3.PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new web3.PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
);

async function getAssociatedTokenAddress(mint, owner) {
  const [ata] = await web3.PublicKey.findProgramAddress(
    [
      owner.toBuffer(),
      TOKEN_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

function u64ToBufferLE(nBig) {
  const b = Buffer.alloc(8);
  let n = BigInt(nBig);
  for (let i = 0; i < 8; i++) {
    b[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return b;
}

function makeBurnInstruction({ tokenAccount, mint, owner, amountRaw }) {
  // SPL Token burn instruction: tag=8, amount=u64 LE
  const data = Buffer.concat([Buffer.from([8]), u64ToBufferLE(amountRaw)]);
  return new web3.TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}


// ---------------- SOLANA CONNECTION ----------------

const connection = new web3.Connection(SOLANA_RPC_URL, 'confirmed');

// ---------------- HELPERS ----------------

async function getAllTokenAccounts(ownerPubkey) {
  const results = [];
  const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  for (const programId of programs) {
    try {
      const resp = await connection.getParsedTokenAccountsByOwner(ownerPubkey, { programId });
      for (const it of resp.value || []) {
        const info = it.account?.data?.parsed?.info;
        if (!info) continue;
        const mint = info.mint;
        const amountRaw = info.tokenAmount?.amount;
        const decimals = info.tokenAmount?.decimals;
        if (!mint || amountRaw == null) continue;
        // skip empty
        if (BigInt(amountRaw) === 0n) continue;
        results.push({
          pubkey: it.pubkey,
          mint,
          amountRaw: BigInt(amountRaw),
          decimals,
          programId: programId.toBase58(),
        });
      }
    } catch (e) {
      console.warn('[WORKER] getParsedTokenAccountsByOwner failed for program', programId.toBase58(), e?.message || String(e));
    }
  }
  return results;
}


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
        details: { BURN_WALLET, CRYPTOCARDS_MINT, BURN_THRESHOLD_SOL },
      };
    }

    const burnKeypair = getBurnWalletKeypair();
    if (!burnKeypair) {
      return { ok: false, error: 'no_burn_wallet_secret' };
    }

    const burnPubkey = new web3.PublicKey(BURN_WALLET);
    if (!burnKeypair.publicKey.equals(burnPubkey)) {
      return {
        ok: false,
        error: 'secret_pubkey_mismatch',
        burnWallet: BURN_WALLET,
        secretPubkey: burnKeypair.publicKey.toBase58(),
      };
    }

    const cryptoMint = new web3.PublicKey(CRYPTOCARDS_MINT);

    // 1) Get burn wallet SOL balance (threshold gate)
    const lamports = await connection.getBalance(burnPubkey, 'confirmed');
    const solBalance = lamports / web3.LAMPORTS_PER_SOL;

    console.log(
      `[WORKER] Burn wallet balance = ${solBalance} SOL (${lamports} lamports)`
    );

    if (solBalance < BURN_THRESHOLD_SOL) {
      return {
        ok: false,
        error: 'below_threshold',
        burnWallet: burnKeypair.publicKey.toBase58(),
        balanceSol: solBalance,
        thresholdSol: BURN_THRESHOLD_SOL,
      };
    }

    // Swap helper (Jupiter quote + swap)
    async function doJupiterSwap({ inputMint, outputMint, amount, wrapAndUnwrapSol }) {
      const quoteUrl =
        `${JUPITER_BASE_URL}/quote` +
        `?inputMint=${encodeURIComponent(inputMint)}` +
        `&outputMint=${encodeURIComponent(outputMint)}` +
        `&amount=${encodeURIComponent(String(amount))}` +
        `&slippageBps=100`;

      const quoteHeaders = {};
      if (JUPITER_API_KEY) quoteHeaders['x-api-key'] = JUPITER_API_KEY;

      console.log('[WORKER] GET', quoteUrl);
      const quoteRes = await fetch(quoteUrl, { method: 'GET', headers: quoteHeaders });
      if (!quoteRes.ok) {
        const bodyText = await quoteRes.text().catch(() => '');
        return { ok: false, step: 'quote', status: quoteRes.status, body: bodyText };
      }
      const quoteJson = await quoteRes.json();
      if (!quoteJson) return { ok: false, step: 'quote', error: 'empty_quote' };

      const swapBody = {
        quoteResponse: quoteJson,
        userPublicKey: burnPubkey.toBase58(),
        wrapAndUnwrapSol: !!wrapAndUnwrapSol,
      };

      const swapHeaders = { 'Content-Type': 'application/json' };
      if (JUPITER_API_KEY) swapHeaders['x-api-key'] = JUPITER_API_KEY;

      console.log('[WORKER] POST', `${JUPITER_BASE_URL}/swap`);
      const swapRes = await fetch(`${JUPITER_BASE_URL}/swap`, {
        method: 'POST',
        headers: swapHeaders,
        body: JSON.stringify(swapBody),
      });

      if (!swapRes.ok) {
        const bodyText = await swapRes.text().catch(() => '');
        return { ok: false, step: 'swap_build', status: swapRes.status, body: bodyText };
      }

      const swapJson = await swapRes.json();
      const swapTxBase64 = swapJson.swapTransaction || swapJson.swapTransactionBase64;
      if (!swapTxBase64) return { ok: false, step: 'swap_build', error: 'missing_swap_transaction', raw: swapJson };

      const txBuf = Buffer.from(swapTxBase64, 'base64');
      const tx = web3.VersionedTransaction.deserialize(txBuf);
      tx.sign([burnKeypair]);

      const rawTx = tx.serialize();
      let sig;
      try {
        sig = await connection.sendRawTransaction(rawTx, { skipPreflight: false, maxRetries: 3 });
      } catch (sendErr) {
        return { ok: false, step: 'send', error: 'send_failed', details: sendErr?.message || String(sendErr) };
      }

      try {
        await connection.confirmTransaction(sig, 'confirmed');
      } catch (confErr) {
        console.error('[WORKER] confirmTransaction error:', confErr);
      }

      return { ok: true, signature: sig, quote: quoteJson };
    }

    const swaps = [];

    // 2) Swap spendable SOL -> $CRYPTOCARDS (leave a safety fraction behind)
    const feeReserveLamports = Math.floor(FEE_RESERVE_SOL * web3.LAMPORTS_PER_SOL);
    const spendableLamports = Math.max(0, lamports - feeReserveLamports);
    const swapLamports = Math.floor(spendableLamports * SAFETY_FRACTION);

    if (swapLamports > 0) {
      const solSwap = await doJupiterSwap({
        inputMint: SOL_MINT_ADDRESS,
        outputMint: CRYPTOCARDS_MINT,
        amount: swapLamports,
        wrapAndUnwrapSol: true,
      });
      if (solSwap.ok) {
        swaps.push({ inputMint: SOL_MINT_ADDRESS, amount: swapLamports, signature: solSwap.signature });
      } else {
        console.warn('[WORKER] SOL swap failed', solSwap);
      }
    } else {
      console.warn('[WORKER] swapLamports <= 0 after safety fraction', {
        lamports,
        spendableLamports,
        feeReserveLamports,
        safetyFraction: SAFETY_FRACTION,
      });
    }

    // 3) Swap any other SPL tokens in burn wallet -> $CRYPTOCARDS
    const tokenAccounts = await getAllTokenAccounts(burnPubkey);
    for (const ta of tokenAccounts) {
      const mintStr = String(ta.mint || '').trim();
      if (!mintStr) continue;
      if (mintStr === CRYPTOCARDS_MINT) continue; // already target token
      // Avoid attempting to swap WSOL token account amounts here; SOL handled above
      if (mintStr === SOL_MINT_ADDRESS) continue;

      const amountRaw = ta.amountRaw;
      if (!amountRaw || amountRaw <= 0n) continue;

      const tokenSwap = await doJupiterSwap({
        inputMint: mintStr,
        outputMint: CRYPTOCARDS_MINT,
        amount: amountRaw.toString(),
        wrapAndUnwrapSol: false,
      });

      if (tokenSwap.ok) {
        swaps.push({ inputMint: mintStr, amount: amountRaw.toString(), signature: tokenSwap.signature });
      } else {
        console.warn('[WORKER] Token swap failed', { mint: mintStr, err: tokenSwap });
      }
    }

    // 4) Burn all $CRYPTOCARDS tokens now held by burn wallet
    let burnSignature = null;
    let burnedAmountRaw = '0';

    try {
      const ata = await getAssociatedTokenAddress(cryptoMint, burnPubkey);
      const bal = await connection.getTokenAccountBalance(ata).catch(() => null);

      const amountStr = bal?.value?.amount;
      if (amountStr && BigInt(amountStr) > 0n) {
        const amountRaw = BigInt(amountStr);

        const burnIx = makeBurnInstruction({
          tokenAccount: ata,
          mint: cryptoMint,
          owner: burnPubkey,
          amountRaw,
        });

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

        const burnTx = new web3.Transaction({
          feePayer: burnPubkey,
          recentBlockhash: blockhash,
        }).add(burnIx);

        burnTx.sign(burnKeypair);

        const raw = burnTx.serialize();
        burnSignature = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });

        try {
          await connection.confirmTransaction(
            { signature: burnSignature, blockhash, lastValidBlockHeight },
            'confirmed'
          );
        } catch (e) {
          console.error('[WORKER] burn confirm error:', e);
        }

        burnedAmountRaw = amountRaw.toString();
        console.log('[WORKER] Burned $CRYPTOCARDS tokens:', burnedAmountRaw, 'tx=', burnSignature);
      } else {
        console.log('[WORKER] No $CRYPTOCARDS tokens to burn');
      }
    } catch (burnErr) {
      console.error('[WORKER] Burn step failed:', burnErr);
    }

    return {
      ok: true,
      burnWallet: burnPubkey.toBase58(),
      thresholdSol: BURN_THRESHOLD_SOL,
      solBalance,
      swaps,
      burnedAmountRaw,
      burnSignature,
    };
  } catch (err) {
    console.error('[WORKER] runBurnSwap unexpected error:', err);
    return { ok: false, error: err?.message || String(err) };
  }
}
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
