import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RewardsVault } from "../target/types/rewards_vault";
import { PublicKey, Keypair, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";

const CONFIG_SEED = Buffer.from("config");
const OPERATOR_SEED = Buffer.from("operator");
const REWARD_SEED = Buffer.from("reward");

describe("rewards_vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.RewardsVault as Program<RewardsVault>;
  const pid = program.programId;

  const owner = provider.wallet as anchor.Wallet; // payer + owner
  const operator = Keypair.generate();
  const trader = Keypair.generate();
  const referrer = Keypair.generate();
  const treasury = Keypair.generate();

  const [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], pid);
  const [operatorPda] = PublicKey.findProgramAddressSync(
    [OPERATOR_SEED, operator.publicKey.toBuffer()],
    pid
  );
  const rewardPda = (u: PublicKey) =>
    PublicKey.findProgramAddressSync([REWARD_SEED, u.toBuffer()], pid)[0];

  const airdrop = async (pk: PublicKey, sol = 2) => {
    const sig = await provider.connection.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
  };

  const rentOf = async (pk: PublicKey) => {
    const info = await provider.connection.getAccountInfo(pk);
    return provider.connection.getMinimumBalanceForRentExemption(info!.data.length);
  };

  before(async () => {
    await airdrop(operator.publicKey, 5);
    await airdrop(trader.publicKey);
    await airdrop(referrer.publicKey);
  });

  it("initializes", async () => {
    await program.methods
      .initialize(owner.publicKey, treasury.publicKey)
      .accounts({ config: configPda, payer: owner.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    const c = await program.account.config.fetch(configPda);
    assert.ok(c.owner.equals(owner.publicKey));
    assert.ok(c.treasury.equals(treasury.publicKey));
    assert.equal(c.treasuryOwed.toNumber(), 0);
  });

  it("enables the operator", async () => {
    await program.methods
      .setOperatorEnable(operator.publicKey)
      .accounts({ config: configPda, owner: owner.publicKey, operatorPda, systemProgram: SystemProgram.programId })
      .rpc();
    const op = await program.account.operator.fetch(operatorPda);
    assert.ok(op.bump > 0);
  });

  it("sets a referrer (write-once)", async () => {
    await program.methods
      .setReferrer(trader.publicKey, referrer.publicKey)
      .accounts({
        config: configPda,
        operator: operator.publicKey,
        operatorPda,
        traderReward: rewardPda(trader.publicKey),
        referrerReward: rewardPda(referrer.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([operator])
      .rpc();
    const tr = await program.account.rewardAccount.fetch(rewardPda(trader.publicKey));
    assert.ok(tr.referrer.equals(referrer.publicKey));

    // write-once: a second set must fail.
    let threw = false;
    try {
      await program.methods
        .setReferrer(trader.publicKey, owner.publicKey)
        .accounts({
          config: configPda,
          operator: operator.publicKey,
          operatorPda,
          traderReward: rewardPda(trader.publicKey),
          referrerReward: rewardPda(owner.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .signers([operator])
        .rpc();
    } catch {
      threw = true;
    }
    assert.isTrue(threw, "referrer should be write-once");
  });

  it("deposits a fee and splits it 25/tier/remainder", async () => {
    const amount = 1 * LAMPORTS_PER_SOL;
    const cashbackBps = 1000; // 10%
    await program.methods
      .depositFee(trader.publicKey, cashbackBps, new anchor.BN(amount))
      .accounts({
        config: configPda,
        operator: operator.publicKey,
        operatorPda,
        traderReward: rewardPda(trader.publicKey),
        referrerReward: rewardPda(referrer.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([operator])
      .rpc();

    const tr = await program.account.rewardAccount.fetch(rewardPda(trader.publicKey));
    const rr = await program.account.rewardAccount.fetch(rewardPda(referrer.publicKey));
    const c = await program.account.config.fetch(configPda);

    const referral = (amount * 2500) / 10000;
    const cashback = (amount * cashbackBps) / 10000;
    const treasuryAmt = amount - referral - cashback;
    assert.equal(rr.referralOwed.toNumber(), referral);
    assert.equal(tr.cashbackOwed.toNumber(), cashback);
    assert.equal(c.treasuryOwed.toNumber(), treasuryAmt);

    // Solvency invariant: config.lamports - rent == sum(owed).
    const info = await provider.connection.getAccountInfo(configPda);
    const rent = await provider.connection.getMinimumBalanceForRentExemption(info!.data.length);
    const owed = referral + cashback + treasuryAmt;
    assert.equal(info!.lamports - rent, owed, "solvency invariant");
  });

  it("lets the trader claim cashback and the referrer claim referral", async () => {
    const before = await provider.connection.getBalance(trader.publicKey);
    await program.methods
      .claimCashback()
      .accounts({ config: configPda, user: trader.publicKey, reward: rewardPda(trader.publicKey) })
      .signers([trader])
      .rpc();
    const after = await provider.connection.getBalance(trader.publicKey);
    assert.isAbove(after, before, "cashback paid out");
    const tr = await program.account.rewardAccount.fetch(rewardPda(trader.publicKey));
    assert.equal(tr.cashbackOwed.toNumber(), 0);

    await program.methods
      .claimReferral()
      .accounts({ config: configPda, user: referrer.publicKey, reward: rewardPda(referrer.publicKey) })
      .signers([referrer])
      .rpc();
    const rr = await program.account.rewardAccount.fetch(rewardPda(referrer.publicKey));
    assert.equal(rr.referralOwed.toNumber(), 0);
  });

  it("withdraws the treasury slice to the treasury address", async () => {
    const c0 = await program.account.config.fetch(configPda);
    const owed = c0.treasuryOwed.toNumber();
    const before = await provider.connection.getBalance(treasury.publicKey);
    await program.methods
      .withdrawTreasury(new anchor.BN(owed))
      .accounts({ config: configPda, authority: owner.publicKey, treasury: treasury.publicKey })
      .rpc();
    const after = await provider.connection.getBalance(treasury.publicKey);
    assert.equal(after - before, owed, "treasury received its slice");
    const c1 = await program.account.config.fetch(configPda);
    assert.equal(c1.treasuryOwed.toNumber(), 0);
  });
});
