// Post-deploy initialization, run against mainnet by the deploy workflow.
// Sets up the vault and reads the state back as proof it works.
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";

const TREASURY = new PublicKey("366sLirZUpwnmKygmLG1PT6LqaAPhmvrxnEeANpZuC8z");
const OPERATOR = new PublicKey("HpnhA2fQorhjwegXCgP1Z4QvUwk5N8wLM5HynaEo86LP");
// ~$5 floor in lamports (SOL ~ $166). Owner-updatable via set_min_claim; the bot
// enforces the exact $5 off-chain, mirroring the EVM vault.
const MIN_CLAIM_LAMPORTS = new anchor.BN(30_000_000);

(async () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program: any = anchor.workspace.RewardsVault;
  const pid: PublicKey = program.programId;
  const owner: PublicKey = provider.wallet.publicKey;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], pid);
  const [operatorPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("operator"), OPERATOR.toBuffer()],
    pid
  );

  console.log("PROGRAM_ID=" + pid.toBase58());
  console.log("OWNER=" + owner.toBase58());
  console.log("TREASURY=" + TREASURY.toBase58());
  console.log("OPERATOR=" + OPERATOR.toBase58());

  // If the config already exists (a re-run), skip initialize.
  const existing = await provider.connection.getAccountInfo(configPda);
  if (!existing) {
    const s = await program.methods
      .initialize(owner, TREASURY)
      .accounts({ config: configPda, payer: owner, systemProgram: SystemProgram.programId })
      .rpc();
    console.log("INIT_SIG=" + s);
  } else {
    console.log("INIT_SIG=(already initialized)");
  }

  const opInfo = await provider.connection.getAccountInfo(operatorPda);
  if (!opInfo) {
    const s = await program.methods
      .setOperatorEnable(OPERATOR)
      .accounts({ config: configPda, owner, operatorPda, systemProgram: SystemProgram.programId })
      .rpc();
    console.log("SET_OPERATOR_SIG=" + s);
  } else {
    console.log("SET_OPERATOR_SIG=(already enabled)");
  }

  const s3 = await program.methods
    .setMinClaim(MIN_CLAIM_LAMPORTS)
    .accounts({ config: configPda, owner })
    .rpc();
  console.log("SET_MIN_CLAIM_SIG=" + s3);

  const cfg = await program.account.config.fetch(configPda);
  const op = await program.account.operator.fetch(operatorPda);
  console.log(
    "READBACK owner=" +
      cfg.owner.toBase58() +
      " treasury=" +
      cfg.treasury.toBase58() +
      " minClaim=" +
      cfg.minClaimLamports.toString() +
      " treasuryOwed=" +
      cfg.treasuryOwed.toString() +
      " operatorEnabled=" +
      (op.bump > 0 ? "yes" : "no")
  );
  console.log("INIT_DONE");
})().catch((e) => {
  console.error("INIT_FAILED", e);
  process.exit(1);
});
