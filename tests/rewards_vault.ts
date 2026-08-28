import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RewardsVault } from "../target/types/rewards_vault";
import { PublicKey, Keypair, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";

const CONFIG_SEED = Buffer.from("config");
const OPERATOR_SEED = Buffer.from("operator");
const REWARD_SEED = Buffer.from("reward");
const REFERRAL_BPS = 2500;
const MAX_CASHBACK_BPS = 2500;

describe("rewards_vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.RewardsVault as Program<RewardsVault>;
  const pid = program.programId;

  const owner = provider.wallet as anchor.Wallet; // payer + owner
  const operator = Keypair.generate();
  const treasury = Keypair.generate();

  const [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], pid);
  const operatorPdaOf = (op: PublicKey) =>
    PublicKey.findProgramAddressSync([OPERATOR_SEED, op.toBuffer()], pid)[0];
  const rewardPda = (u: PublicKey) =>
    PublicKey.findProgramAddressSync([REWARD_SEED, u.toBuffer()], pid)[0];
  const operatorPda = operatorPdaOf(operator.publicKey);

  const airdrop = async (pk: PublicKey, sol = 2) => {
    const sig = await provider.connection.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
  };
  const bal = (pk: PublicKey) => provider.connection.getBalance(pk);
  const rentOfConfig = async () => {
    const info = await provider.connection.getAccountInfo(configPda);
    return provider.connection.getMinimumBalanceForRentExemption(info!.data.length);
  };

  // Assert a tx REVERTS, optionally with a specific Anchor error code/name.
  const mustFail = async (p: Promise<any>, code?: string) => {
    try {
      await p;
    } catch (e: any) {
      if (code) {
        const s = `${e}\n${JSON.stringify(e?.logs ?? "")}\n${e?.error?.errorCode?.code ?? ""}`;
        assert.include(s, code, `expected error "${code}", got: ${e?.message ?? e}`);
      }
      return;
    }
    assert.fail(`expected the tx to fail${code ? ` with ${code}` : ""}, but it succeeded`);
  };

  // ── One-time setup ─────────────────────────────────────────────────────────
  before(async () => {
    await airdrop(operator.publicKey, 50);
    // initialize is a singleton; ignore if a prior run already created it.
    try {
      await program.methods
        .initialize(owner.publicKey, treasury.publicKey)
        .accounts({ config: configPda, payer: owner.publicKey, systemProgram: SystemProgram.programId })
        .rpc();
    } catch {
      /* already initialized on this validator */
    }
    // Make sure treasury is the one we control for these tests.
    await program.methods
      .setTreasury(treasury.publicKey)
      .accounts({ config: configPda, owner: owner.publicKey })
      .rpc();
    // Enable the main operator (idempotent).
    await program.methods
      .setOperatorEnable(operator.publicKey)
      .accounts({ config: configPda, owner: owner.publicKey, operatorPda, systemProgram: SystemProgram.programId })
      .rpc();
    // Reset min-claim so happy-path claims are not blocked.
    await program.methods
      .setMinClaim(new anchor.BN(0))
      .accounts({ config: configPda, owner: owner.publicKey })
      .rpc();
  });

  // Helpers bound to the main operator.
  const setReferrer = (trader: PublicKey, referrer: PublicKey) =>
    program.methods
      .setReferrer(trader, referrer)
      .accounts({
        config: configPda,
        operator: operator.publicKey,
        operatorPda,
        traderReward: rewardPda(trader),
        referrerReward: rewardPda(referrer),
        systemProgram: SystemProgram.programId,
      })
      .signers([operator]);

  const deposit = (trader: PublicKey, cashbackBps: number, lamports: number, referrer?: PublicKey) =>
    program.methods
      .depositFee(trader, cashbackBps, new anchor.BN(lamports))
      .accounts({
        config: configPda,
        operator: operator.publicKey,
        operatorPda,
        traderReward: rewardPda(trader),
        referrerReward: referrer ? rewardPda(referrer) : null,
        systemProgram: SystemProgram.programId,
      })
      .signers([operator]);

  // ═══════════════════════ HAPPY PATH ═══════════════════════
  describe("happy path", () => {
    const trader = Keypair.generate();
    const referrer = Keypair.generate();

    it("sets a referrer and splits a fee 25/tier/remainder + solvency", async () => {
      await setReferrer(trader.publicKey, referrer.publicKey).rpc();
      const amount = 1 * LAMPORTS_PER_SOL;
      const cashbackBps = 1000; // 10%
      const rentBefore = await rentOfConfig();
      const cfgBefore = await program.account.config.fetch(configPda);
      const infoBefore = await provider.connection.getAccountInfo(configPda);
      const owedBefore =
        infoBefore!.lamports - rentBefore; // == sum of all owed by the invariant

      await deposit(trader.publicKey, cashbackBps, amount, referrer.publicKey).rpc();

      const referral = (amount * REFERRAL_BPS) / 10000;
      const cashback = (amount * cashbackBps) / 10000;
      const treasuryAmt = amount - referral - cashback;
      const tr = await program.account.rewardAccount.fetch(rewardPda(trader.publicKey));
      const rr = await program.account.rewardAccount.fetch(rewardPda(referrer.publicKey));
      const cfg = await program.account.config.fetch(configPda);
      assert.equal(rr.referralOwed.toNumber(), referral);
      assert.equal(tr.cashbackOwed.toNumber(), cashback);
      assert.equal(cfg.treasuryOwed.toNumber(), cfgBefore.treasuryOwed.toNumber() + treasuryAmt);

      // Solvency: every lamport that entered is now owed to someone.
      const info = await provider.connection.getAccountInfo(configPda);
      const rent = await rentOfConfig();
      assert.equal(info!.lamports - rent, owedBefore + amount, "solvency invariant broken");
    });

    it("lets the trader and referrer claim exactly what they are owed", async () => {
      const trBefore = await bal(trader.publicKey);
      await program.methods
        .claimCashback()
        .accounts({ config: configPda, user: trader.publicKey, reward: rewardPda(trader.publicKey) })
        .signers([trader])
        .rpc();
      assert.isAbove(await bal(trader.publicKey), trBefore);
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

    it("no referrer → the referral slice falls to the treasury", async () => {
      const solo = Keypair.generate();
      const amount = 0.4 * LAMPORTS_PER_SOL;
      const before = (await program.account.config.fetch(configPda)).treasuryOwed.toNumber();
      await deposit(solo.publicKey, 0, amount).rpc(); // no referrer account
      const after = (await program.account.config.fetch(configPda)).treasuryOwed.toNumber();
      assert.equal(after - before, amount, "whole fee should go to treasury when no referrer & 0 cashback");
    });

    it("owner can withdraw the treasury to the treasury address", async () => {
      const owed = (await program.account.config.fetch(configPda)).treasuryOwed.toNumber();
      const before = await bal(treasury.publicKey);
      await program.methods
        .withdrawTreasury(new anchor.BN(owed))
        .accounts({ config: configPda, authority: owner.publicKey, treasury: treasury.publicKey })
        .rpc();
      assert.equal((await bal(treasury.publicKey)) - before, owed);
      assert.equal((await program.account.config.fetch(configPda)).treasuryOwed.toNumber(), 0);
    });
  });

  // ═══════════════════════ ACCESS CONTROL ═══════════════════════
  describe("access control", () => {
    it("a non-operator cannot deposit_fee", async () => {
      const evil = Keypair.generate();
      await airdrop(evil.publicKey, 2);
      const trader = Keypair.generate();
      await mustFail(
        program.methods
          .depositFee(trader.publicKey, 0, new anchor.BN(1000))
          .accounts({
            config: configPda,
            operator: evil.publicKey,
            operatorPda: operatorPdaOf(evil.publicKey), // does not exist
            traderReward: rewardPda(trader.publicKey),
            referrerReward: null,
            systemProgram: SystemProgram.programId,
          })
          .signers([evil])
          .rpc(),
        "AccountNotInitialized"
      );
    });

    it("a non-operator cannot set_referrer", async () => {
      const evil = Keypair.generate();
      await airdrop(evil.publicKey, 2);
      const a = Keypair.generate();
      const b = Keypair.generate();
      await mustFail(
        program.methods
          .setReferrer(a.publicKey, b.publicKey)
          .accounts({
            config: configPda,
            operator: evil.publicKey,
            operatorPda: operatorPdaOf(evil.publicKey),
            traderReward: rewardPda(a.publicKey),
            referrerReward: rewardPda(b.publicKey),
            systemProgram: SystemProgram.programId,
          })
          .signers([evil])
          .rpc(),
        "AccountNotInitialized"
      );
    });

    it("a non-owner cannot enable an operator", async () => {
      const evil = Keypair.generate();
      await airdrop(evil.publicKey, 2);
      const victim = Keypair.generate();
      await mustFail(
        program.methods
          .setOperatorEnable(victim.publicKey)
          .accounts({
            config: configPda,
            owner: evil.publicKey,
            operatorPda: operatorPdaOf(victim.publicKey),
            systemProgram: SystemProgram.programId,
          })
          .signers([evil])
          .rpc(),
        "NotOwner"
      );
    });

    it("a disabled operator can no longer deposit", async () => {
      const throwaway = Keypair.generate();
      await airdrop(throwaway.publicKey, 3);
      const tpda = operatorPdaOf(throwaway.publicKey);
      await program.methods
        .setOperatorEnable(throwaway.publicKey)
        .accounts({ config: configPda, owner: owner.publicKey, operatorPda: tpda, systemProgram: SystemProgram.programId })
        .rpc();
      const trader = Keypair.generate();
      // works while enabled
      await program.methods
        .depositFee(trader.publicKey, 0, new anchor.BN(1000))
        .accounts({ config: configPda, operator: throwaway.publicKey, operatorPda: tpda, traderReward: rewardPda(trader.publicKey), referrerReward: null, systemProgram: SystemProgram.programId })
        .signers([throwaway])
        .rpc();
      // disable
      await program.methods
        .setOperatorDisable(throwaway.publicKey)
        .accounts({ config: configPda, owner: owner.publicKey, operatorPda: tpda })
        .rpc();
      // now fails (PDA closed)
      await mustFail(
        program.methods
          .depositFee(trader.publicKey, 0, new anchor.BN(1000))
          .accounts({ config: configPda, operator: throwaway.publicKey, operatorPda: tpda, traderReward: rewardPda(trader.publicKey), referrerReward: null, systemProgram: SystemProgram.programId })
          .signers([throwaway])
          .rpc(),
        "AccountNotInitialized"
      );
    });
  });

  // ═══════════════════════ REFERRER RULES ═══════════════════════
  describe("referrer rules", () => {
    it("rejects self-referral", async () => {
      const a = Keypair.generate();
      await mustFail(setReferrer(a.publicKey, a.publicKey).rpc(), "SelfReferral");
    });

    it("is write-once — a second set reverts", async () => {
      const trader = Keypair.generate();
      const r1 = Keypair.generate();
      const r2 = Keypair.generate();
      await setReferrer(trader.publicKey, r1.publicKey).rpc();
      await mustFail(setReferrer(trader.publicKey, r2.publicKey).rpc(), "ReferrerAlreadySet");
    });

    it("deposit with the WRONG referrer_reward account reverts", async () => {
      const trader = Keypair.generate();
      const referrer = Keypair.generate();
      const attacker = Keypair.generate();
      await setReferrer(trader.publicKey, referrer.publicKey).rpc();
      // Give the attacker a real reward account so it deserializes, then try to
      // divert the referral slice to it instead of the true referrer.
      await deposit(attacker.publicKey, 0, 1000).rpc();
      await mustFail(
        program.methods
          .depositFee(trader.publicKey, 0, new anchor.BN(LAMPORTS_PER_SOL))
          .accounts({
            config: configPda,
            operator: operator.publicKey,
            operatorPda,
            traderReward: rewardPda(trader.publicKey),
            referrerReward: rewardPda(attacker.publicKey), // WRONG
            systemProgram: SystemProgram.programId,
          })
          .signers([operator])
          .rpc(),
        "ReferrerAccountMismatch"
      );
    });

    it("deposit for a referred trader with NO referrer_reward supplied reverts", async () => {
      const trader = Keypair.generate();
      const referrer = Keypair.generate();
      await setReferrer(trader.publicKey, referrer.publicKey).rpc();
      await mustFail(
        deposit(trader.publicKey, 0, LAMPORTS_PER_SOL /* no referrer arg → null */).rpc(),
        "ReferrerAccountMissing"
      );
    });
  });

  // ═══════════════════════ CLAIMS ═══════════════════════
  describe("claims", () => {
    it("double-claim reverts (nothing left the second time)", async () => {
      const trader = Keypair.generate();
      await deposit(trader.publicKey, MAX_CASHBACK_BPS, LAMPORTS_PER_SOL).rpc();
      await program.methods
        .claimCashback()
        .accounts({ config: configPda, user: trader.publicKey, reward: rewardPda(trader.publicKey) })
        .signers([trader])
        .rpc();
      await mustFail(
        program.methods
          .claimCashback()
          .accounts({ config: configPda, user: trader.publicKey, reward: rewardPda(trader.publicKey) })
          .signers([trader])
          .rpc(),
        "NothingToClaim"
      );
    });

    it("claim below min_claim reverts, then succeeds after lowering it", async () => {
      const trader = Keypair.generate();
      await deposit(trader.publicKey, MAX_CASHBACK_BPS, 100_000).rpc(); // cashback 25% = 25_000
      await program.methods
        .setMinClaim(new anchor.BN(1_000_000))
        .accounts({ config: configPda, owner: owner.publicKey })
        .rpc();
      await mustFail(
        program.methods
          .claimCashback()
          .accounts({ config: configPda, user: trader.publicKey, reward: rewardPda(trader.publicKey) })
          .signers([trader])
          .rpc(),
        "BelowMinClaim"
      );
      await program.methods
        .setMinClaim(new anchor.BN(0))
        .accounts({ config: configPda, owner: owner.publicKey })
        .rpc();
      await program.methods
        .claimCashback()
        .accounts({ config: configPda, user: trader.publicKey, reward: rewardPda(trader.publicKey) })
        .signers([trader])
        .rpc(); // now works
    });

    it("claiming with nothing owed reverts", async () => {
      const nobody = Keypair.generate();
      await airdrop(nobody.publicKey, 1);
      // create an empty reward account via a 0-cashback deposit
      await deposit(nobody.publicKey, 0, 1000).rpc();
      await mustFail(
        program.methods
          .claimCashback()
          .accounts({ config: configPda, user: nobody.publicKey, reward: rewardPda(nobody.publicKey) })
          .signers([nobody])
          .rpc(),
        "NothingToClaim"
      );
    });

    it("cannot claim someone else's rewards (seeds bind the reward to the signer)", async () => {
      const victim = Keypair.generate();
      const attacker = Keypair.generate();
      await airdrop(attacker.publicKey, 1);
      await deposit(victim.publicKey, MAX_CASHBACK_BPS, LAMPORTS_PER_SOL).rpc();
      // attacker signs but points at victim's reward PDA → seeds constraint fails
      await mustFail(
        program.methods
          .claimCashback()
          .accounts({ config: configPda, user: attacker.publicKey, reward: rewardPda(victim.publicKey) })
          .signers([attacker])
          .rpc(),
        "ConstraintSeeds"
      );
    });
  });

  // ═══════════════════════ TREASURY ═══════════════════════
  describe("treasury withdrawal", () => {
    const fund = async () => {
      const t = Keypair.generate();
      await deposit(t.publicKey, 0, LAMPORTS_PER_SOL).rpc(); // all to treasury
    };

    it("a random signer cannot withdraw the treasury", async () => {
      await fund();
      const evil = Keypair.generate();
      await airdrop(evil.publicKey, 1);
      await mustFail(
        program.methods
          .withdrawTreasury(new anchor.BN(1))
          .accounts({ config: configPda, authority: evil.publicKey, treasury: treasury.publicKey })
          .signers([evil])
          .rpc(),
        "NotOwner"
      );
    });

    it("cannot withdraw more than treasury_owed", async () => {
      const owed = (await program.account.config.fetch(configPda)).treasuryOwed.toNumber();
      await mustFail(
        program.methods
          .withdrawTreasury(new anchor.BN(owed + 1))
          .accounts({ config: configPda, authority: owner.publicKey, treasury: treasury.publicKey })
          .rpc(),
        "InsufficientTreasury"
      );
    });

    it("cannot redirect the withdrawal to a non-treasury address", async () => {
      await fund();
      const attacker = Keypair.generate();
      await mustFail(
        program.methods
          .withdrawTreasury(new anchor.BN(1))
          .accounts({ config: configPda, authority: owner.publicKey, treasury: attacker.publicKey })
          .rpc(),
        "TreasuryMismatch"
      );
    });

    it("the treasury wallet itself may withdraw (to itself)", async () => {
      await airdrop(treasury.publicKey, 1);
      await fund();
      const owed = (await program.account.config.fetch(configPda)).treasuryOwed.toNumber();
      const before = await bal(treasury.publicKey);
      await program.methods
        .withdrawTreasury(new anchor.BN(owed))
        .accounts({ config: configPda, authority: treasury.publicKey, treasury: treasury.publicKey })
        .signers([treasury])
        .rpc();
      assert.equal((await bal(treasury.publicKey)) - before, owed);
    });
  });

  // ═══════════════════════ SPLIT MATH / OVERFLOW / SOLVENCY ═══════════════════════
  describe("split math, clamping, and solvency", () => {
    it("zero-value deposit reverts", async () => {
      const t = Keypair.generate();
      await mustFail(deposit(t.publicKey, 0, 0).rpc(), "ZeroValue");
    });

    it("cashback bps is clamped to 25% no matter what the operator passes", async () => {
      const trader = Keypair.generate();
      const amount = LAMPORTS_PER_SOL;
      await deposit(trader.publicKey, 60000, amount).rpc(); // absurd 600%
      const tr = await program.account.rewardAccount.fetch(rewardPda(trader.publicKey));
      assert.equal(tr.cashbackOwed.toNumber(), (amount * MAX_CASHBACK_BPS) / 10000, "cashback must cap at 25%");
    });

    it("repeated deposits ACCUMULATE (init_if_needed never resets balances)", async () => {
      const trader = Keypair.generate();
      await deposit(trader.publicKey, MAX_CASHBACK_BPS, 1_000_000).rpc();
      await deposit(trader.publicKey, MAX_CASHBACK_BPS, 1_000_000).rpc();
      const tr = await program.account.rewardAccount.fetch(rewardPda(trader.publicKey));
      assert.equal(tr.cashbackOwed.toNumber(), 2 * ((1_000_000 * MAX_CASHBACK_BPS) / 10000));
    });

    it("large deposit uses u128 intermediate math (no overflow) and stays solvent", async () => {
      const trader = Keypair.generate();
      const referrer = Keypair.generate();
      await setReferrer(trader.publicKey, referrer.publicKey).rpc();
      const amount = 40 * LAMPORTS_PER_SOL; // large but fundable by the operator
      const rentBefore = await rentOfConfig();
      const infoBefore = await provider.connection.getAccountInfo(configPda);
      const owedBefore = infoBefore!.lamports - rentBefore;
      await deposit(trader.publicKey, MAX_CASHBACK_BPS, amount, referrer.publicKey).rpc();
      const referral = (amount * REFERRAL_BPS) / 10000;
      const cashback = (amount * MAX_CASHBACK_BPS) / 10000;
      const tr = await program.account.rewardAccount.fetch(rewardPda(trader.publicKey));
      const rr = await program.account.rewardAccount.fetch(rewardPda(referrer.publicKey));
      assert.equal(tr.cashbackOwed.toNumber(), cashback);
      assert.equal(rr.referralOwed.toNumber(), referral);
      const info = await provider.connection.getAccountInfo(configPda);
      const rent = await rentOfConfig();
      assert.equal(info!.lamports - rent, owedBefore + amount, "solvency invariant broken on large deposit");
    });
  });

  // ═══════════════════════ OWNERSHIP (2-step) ═══════════════════════
  describe("ownership (2-step)", () => {
    it("only the pending owner can accept, and ownership transfers cleanly (then restored)", async () => {
      const newOwner = Keypair.generate();
      await airdrop(newOwner.publicKey, 2);

      await program.methods
        .transferOwnership(newOwner.publicKey)
        .accounts({ config: configPda, owner: owner.publicKey })
        .rpc();

      // a random key cannot accept
      const evil = Keypair.generate();
      await airdrop(evil.publicKey, 1);
      await mustFail(
        program.methods
          .acceptOwnership()
          .accounts({ config: configPda, newOwner: evil.publicKey })
          .signers([evil])
          .rpc(),
        "NotOwner"
      );

      // the pending owner accepts
      await program.methods
        .acceptOwnership()
        .accounts({ config: configPda, newOwner: newOwner.publicKey })
        .signers([newOwner])
        .rpc();
      assert.ok((await program.account.config.fetch(configPda)).owner.equals(newOwner.publicKey));

      // the OLD owner can no longer administer
      await mustFail(
        program.methods
          .setMinClaim(new anchor.BN(1))
          .accounts({ config: configPda, owner: owner.publicKey })
          .rpc(),
        "NotOwner"
      );

      // restore ownership so later runs keep working
      await program.methods
        .transferOwnership(owner.publicKey)
        .accounts({ config: configPda, owner: newOwner.publicKey })
        .signers([newOwner])
        .rpc();
      await program.methods
        .acceptOwnership()
        .accounts({ config: configPda, newOwner: owner.publicKey })
        .rpc();
      assert.ok((await program.account.config.fetch(configPda)).owner.equals(owner.publicKey));
    });
  });
});
