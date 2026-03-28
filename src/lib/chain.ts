import { Connection, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";

export async function getChainTime(connection: Connection): Promise<number> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  if (!info?.data || info.data.length < 40) {
    throw new Error("Could not read Clock sysvar");
  }
  return Number(info.data.readBigInt64LE(32));
}
