import "dotenv/config";

import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AuthorityType,
  ExtensionType,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createInitializeMetadataPointerInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
  getMinimumBalanceForRentExemptMint,
  tokenMetadataInitializeWithRentTransfer,
} from "@solana/spl-token";
import {
  DataV2,
  createCreateMetadataAccountV3Instruction,
} from "@metaplex-foundation/mpl-token-metadata";
import { getRequiredEnv, getEnvOrDefault, parseWalletSecret, parseStringArray } from "../lib/utils";
import { saveArtifactByKey, upsertLaunchStateByKey } from "../lib/store/mongo-store";
import { closeMongoClient } from "../lib/store/mongo";

const DEFAULT_LAUNCH_STATE_PATH = "data/latest-launch-state.json";

type TokenProgramType = "SPL" | "TOKEN_2022";

const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const DEFAULT_TOKEN_MINT_OUTPUT_PATH = "data/latest-token-mint.json";

function getMetadataPda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID
  );
  return pda;
}

async function pinFileToIPFS(blob: Blob, pinataApiKey: string, pinataSecretApiKey: string): Promise<string> {
  const form = new FormData();
  form.append("file", blob, "token-image.png");

  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: {
      pinata_api_key: pinataApiKey,
      pinata_secret_api_key: pinataSecretApiKey,
    },
    body: form,
  });

  if (!res.ok) throw new Error(`Pinata image upload failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { IpfsHash: string };
  return `https://ipfs.io/ipfs/${body.IpfsHash}`;
}

function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

async function uploadImageFromPath(
  imagePath: string,
  pinataApiKey: string,
  pinataSecretApiKey: string
): Promise<string> {
  const absPath = resolve(imagePath);
  const bytes = await readFile(absPath);
  const blob = new Blob([bytes], { type: getMimeType(absPath) });
  return pinFileToIPFS(blob, pinataApiKey, pinataSecretApiKey);
}

async function uploadMetadataToPinata(
  metadata: Record<string, unknown>,
  pinataApiKey: string,
  pinataSecretApiKey: string
): Promise<string> {
  const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      pinata_api_key: pinataApiKey,
      pinata_secret_api_key: pinataSecretApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ pinataContent: metadata }),
  });

  if (!response.ok) throw new Error(`Pinata metadata upload failed: ${response.status} ${response.statusText}`);
  const body = (await response.json()) as { IpfsHash: string };
  return `https://ipfs.io/ipfs/${body.IpfsHash}`;
}

async function createTokenMintWithMetadata(params: {
  connection: Connection;
  wallet: Keypair;
  tokenProgram: PublicKey;
  decimals: number;
  initialSupplyRaw: bigint;
  tokenName: string;
  tokenSymbol: string;
  metadataUri: string;
  revokeMintAuthority: boolean;
}): Promise<PublicKey> {
  const { connection, wallet, tokenProgram, decimals, initialSupplyRaw, tokenName, tokenSymbol, metadataUri, revokeMintAuthority } = params;

  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;
  const ownerAta = getAssociatedTokenAddressSync(
    mint,
    wallet.publicKey,
    false,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const metadata: DataV2 = {
    name: tokenName,
    symbol: tokenSymbol,
    uri: metadataUri,
    sellerFeeBasisPoints: 0,
    creators: null,
    collection: null,
    uses: null,
  };

  const tx = new Transaction();

  if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    const mintLen = getMintLen([ExtensionType.MetadataPointer]);
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

    tx.add(
      SystemProgram.createAccount({
        fromPubkey: wallet.publicKey,
        newAccountPubkey: mint,
        space: mintLen,
        lamports,
        programId: tokenProgram,
      })
    );
    tx.add(createInitializeMetadataPointerInstruction(mint, wallet.publicKey, mint, tokenProgram));
    tx.add(createInitializeMintInstruction(mint, decimals, wallet.publicKey, wallet.publicKey, tokenProgram));
  } else {
    const lamports = await getMinimumBalanceForRentExemptMint(connection);
    const metadataPda = getMetadataPda(mint);

    tx.add(
      SystemProgram.createAccount({
        fromPubkey: wallet.publicKey,
        newAccountPubkey: mint,
        space: MintLayout.span,
        lamports,
        programId: tokenProgram,
      })
    );
    tx.add(createInitializeMintInstruction(mint, decimals, wallet.publicKey, null, tokenProgram));
    tx.add(
      createCreateMetadataAccountV3Instruction(
        {
          metadata: metadataPda,
          mint,
          mintAuthority: wallet.publicKey,
          payer: wallet.publicKey,
          updateAuthority: wallet.publicKey,
        },
        {
          createMetadataAccountArgsV3: {
            data: metadata,
            isMutable: true,
            collectionDetails: null,
          },
        }
      )
    );
  }
  tx.add(
    createAssociatedTokenAccountInstruction(
      wallet.publicKey,
      ownerAta,
      wallet.publicKey,
      mint,
      tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID
    )
  );
  tx.add(createMintToInstruction(mint, ownerAta, wallet.publicKey, initialSupplyRaw, [], tokenProgram));

  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.partialSign(mintKeypair);

  await sendAndConfirmTransaction(connection, tx, [wallet, mintKeypair], {
    commitment: "confirmed",
    skipPreflight: false,
  });

  if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    await tokenMetadataInitializeWithRentTransfer(
      connection,
      wallet,
      mint,
      wallet.publicKey,
      wallet,
      tokenName,
      tokenSymbol,
      metadataUri,
      [],
      { commitment: "confirmed" },
      tokenProgram
    );
  }

  if (revokeMintAuthority) {
    const revokeTx = new Transaction();
    revokeTx.add(
      createSetAuthorityInstruction(mint, wallet.publicKey, AuthorityType.MintTokens, null, [], tokenProgram)
    );
    if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
      revokeTx.add(
        createSetAuthorityInstruction(mint, wallet.publicKey, AuthorityType.FreezeAccount, null, [], tokenProgram)
      );
    }
    revokeTx.feePayer = wallet.publicKey;
    revokeTx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    await sendAndConfirmTransaction(connection, revokeTx, [wallet], {
      commitment: "confirmed",
      skipPreflight: false,
    });
  }

  return mint;
}

async function writeTokenMintOutput(params: {
  outputPath: string;
  tokenMint: PublicKey;
  tokenProgramType: TokenProgramType;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimals: number;
  tokenInitialSupplyRaw: string;
  metadataUri: string;
  imageIpfsUrl: string;
}): Promise<void> {
  const {
    outputPath,
    tokenMint,
    tokenProgramType,
    tokenName,
    tokenSymbol,
    tokenDecimals,
    tokenInitialSupplyRaw,
    metadataUri,
    imageIpfsUrl,
  } = params;
  const payload = {
    tokenMint: tokenMint.toBase58(),
    tokenProgram: tokenProgramType,
    tokenName,
    tokenSymbol,
    tokenDecimals,
    tokenInitialSupplyRaw,
    metadataUri,
    imageIpfsUrl,
    createdAt: new Date().toISOString(),
  };

  await saveArtifactByKey("token-mint-output", outputPath, payload);
}

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL?.trim() || clusterApiUrl("devnet");
  const rawSecret = getRequiredEnv("WALLET_SECRET_KEY");

  const tokenProgramType = getEnvOrDefault("TOKEN_PROGRAM", getEnvOrDefault("BASE_TOKEN_PROGRAM", "SPL"))
    .toUpperCase() as TokenProgramType;
  if (!["SPL", "TOKEN_2022"].includes(tokenProgramType)) {
    throw new Error("TOKEN_PROGRAM must be SPL or TOKEN_2022");
  }

  const tokenDecimals = Number(getEnvOrDefault("TOKEN_DECIMALS", getEnvOrDefault("BASE_MINT_DECIMALS", "6")));
  const tokenInitialSupplyRaw = BigInt(
    getEnvOrDefault("TOKEN_INITIAL_SUPPLY_RAW", getEnvOrDefault("BASE_INITIAL_SUPPLY_RAW", "1000000000000"))
  );
  const tokenName = getEnvOrDefault("TOKEN_NAME", "Devnet Base Token");
  const tokenSymbol = getEnvOrDefault("TOKEN_SYMBOL", "DBASE");
  const tokenDescription = getEnvOrDefault(
    "TOKEN_DESCRIPTION",
    "Devnet token minted for Meteora DAMM v2 launch testing."
  );
  const tokenImagePath = getEnvOrDefault("TOKEN_IMAGE_PATH", "image/XD.jpg");
  const tokenSocialLinks = parseStringArray(getEnvOrDefault("TOKEN_SOCIAL_LINKS", "[]"));
  const tokenMintOutputPath = getEnvOrDefault("TOKEN_MINT_OUTPUT_PATH", DEFAULT_TOKEN_MINT_OUTPUT_PATH);

  const pinataApiKey = getRequiredEnv("PINATA_API_KEY");
  const pinataSecretApiKey = getRequiredEnv("PINATA_SECRET_API_KEY");

  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = Keypair.fromSecretKey(parseWalletSecret(rawSecret));

  const currentBalance = await connection.getBalance(wallet.publicKey);
  console.log(`Current balance: ${currentBalance / LAMPORTS_PER_SOL} SOL`);

  const tokenProgram = tokenProgramType === "TOKEN_2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

  console.log(`Uploading local token image to Pinata: ${tokenImagePath}`);
  const imageIpfsUrl = await uploadImageFromPath(tokenImagePath, pinataApiKey, pinataSecretApiKey);
  console.log(`Image uploaded: ${imageIpfsUrl}`);

  console.log("Uploading token metadata JSON to Pinata...");
  const metadataUri = await uploadMetadataToPinata(
    {
      name: tokenName,
      symbol: tokenSymbol,
      description: tokenDescription,
      image: imageIpfsUrl,
      attributes: [],
      properties: {
        files: [{ uri: imageIpfsUrl, type: "image/png" }],
        category: "image",
        links: tokenSocialLinks,
      },
    },
    pinataApiKey,
    pinataSecretApiKey
  );
  console.log(`Metadata uploaded: ${metadataUri}`);

  console.log("Creating token mint + on-chain metadata...");
  if (tokenProgramType === "TOKEN_2022") {
    console.log("Token-2022 selected: initializing metadata pointer + token metadata extension on-chain.");
  }
  const revokeMintAuthority = getEnvOrDefault("TOKEN_REVOKE_MINT_AUTHORITY", "true").toLowerCase() === "true";
  if (revokeMintAuthority) {
    console.log("Legit token: freeze authority = none, mint authority = revoked after initial mint.");
  }
  const tokenMint = await createTokenMintWithMetadata({
    connection,
    wallet,
    tokenProgram,
    decimals: tokenDecimals,
    initialSupplyRaw: tokenInitialSupplyRaw,
    tokenName,
    tokenSymbol,
    metadataUri,
    revokeMintAuthority,
  });

  await writeTokenMintOutput({
    outputPath: tokenMintOutputPath,
    tokenMint,
    tokenProgramType,
    tokenName,
    tokenSymbol,
    tokenDecimals,
    tokenInitialSupplyRaw: tokenInitialSupplyRaw.toString(),
    metadataUri,
    imageIpfsUrl,
  });

  const statePath = getEnvOrDefault("LAUNCH_STATE_PATH", DEFAULT_LAUNCH_STATE_PATH);
  await upsertLaunchStateByKey(statePath, {
    phase: "token-minted",
    tokenMint: tokenMint.toBase58(),
    updatedAt: new Date().toISOString(),
    // Provide required fields with placeholder values; full state is populated after launch
    poolAddress: "",
    alphaVaultAddress: "",
    quoteMintType: "WSOL",
    quoteMint: "",
    poolActivationPointTs: "",
    depositingPoint: "",
    startVestingPoint: "",
    endVestingPoint: "",
    maxDepositingCap: "",
    distributionWallets: [],
    totalDistributedRaw: "0",
    depositsByWallet: {},
    fillTxSignature: null,
    claimsByWallet: {},
    tokenMintOutputPath,
    poolOutputPath: getEnvOrDefault("POOL_OUTPUT_PATH", "data/latest-pool.json"),
    alphaVaultOutputPath: getEnvOrDefault("ALPHA_VAULT_OUTPUT_PATH", "data/latest-alpha-vault.json"),
  });

  console.log("========================================");
  console.log("SETUP COMPLETE");
  console.log("========================================");
  console.log(`TOKEN_MINT=${tokenMint.toBase58()}`);
  console.log(`TOKEN_PROGRAM=${tokenProgramType}`);
  console.log(`TOKEN_METADATA_URI=${metadataUri}`);
  console.log(`TOKEN_IMAGE_IPFS=${imageIpfsUrl}`);
  console.log(`TOKEN_MINT_OUTPUT_PATH=${resolve(tokenMintOutputPath)}`);
  console.log("========================================");
}

main()
  .finally(() => closeMongoClient())
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Setup failed: ${message}`);
    process.exit(1);
  });
