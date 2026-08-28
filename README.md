# RewardsVault — Solana (Anchor)

On-chain split + custody of the bot's 1% trading fee on Solana. A 1:1 port of the
EVM `RewardsVault.sol` (`Desktop/rewardsvault`): the same three-way split
(referral 25% flat → cashback by tier ≤25% → treasury the remainder), the same
pull-claim model, and the same solvency invariant.

> ⚠️ **NOT YET BUILT OR TESTED.** This source was written on a Windows box with no
> Solana toolchain, so it has **not been compiled, tested, or audited**. It holds
> user funds — **do not deploy to mainnet before** a clean `anchor build`, the
> full `anchor test` suite passing, and ideally a review. Treat everything below
> as the recipe to get there, not a finished artifact.

## What it does

| EVM (`RewardsVault.sol`) | Solana (this program) |
|---|---|
| `mapping(addr => uint) cashbackOwed/referralOwed` | per-user `RewardAccount` PDA `["reward", user]` |
| `treasuryOwed`, `owner`, `treasury` | fields on the `Config` PDA `["config"]` |
| `mapping(addr => bool) isOperator` | `Operator` PDA `["operator", op]` (exists = allowed) |
| `address(this).balance` holds the SOL | the program-owned `Config` PDA holds the SOL |
| `depositFee(trader, cashbackBps)` payable | `deposit_fee(trader, cashback_bps, amount)` |
| `setReferrer` (write-once) | `set_referrer` (write-once; also pre-creates the referrer's account) |
| `claimCashback` / `claimReferral` | `claim_cashback` / `claim_referral` |
| `withdrawTreasury` (owner\|treasury) | `withdraw_treasury` (owner\|treasury) |
| 2-step ownership, `setOperator`, `setMinClaim` | `transfer_ownership`/`accept_ownership`, `set_operator_enable`/`_disable`, `set_min_claim` |

**Invariant:** `config.lamports - rent_exempt_minimum == Σcashback_owed +
Σreferral_owed + treasury_owed` after every instruction. Payouts debit the
Config PDA's lamports directly (allowed — the program owns it) and re-check
rent-exemption, so an accounting bug fails loudly instead of purging the account.

**Trust surface** (identical to EVM): the operator supplies the cashback rate
(clamped ≤25% on-chain, only ever out of the deposited fee — can never mint or
break solvency); `set_referrer` is operator-only and write-once.

## Build & deploy (Linux or WSL — NOT native Windows)

Solana SBF builds need Linux. On Windows use WSL2 (Ubuntu).

```bash
# 1. Toolchain
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"      # solana CLI
cargo install --git https://github.com/coral-xyz/anchor avm --force # anchor version manager
avm install 0.30.1 && avm use 0.30.1
rustup component add rustfmt

# 2. Program id — generate the keypair and sync it into the source + Anchor.toml
anchor keys sync         # replaces the declare_id! placeholder with the real one

# 3. Build + test on a local validator
anchor build
anchor test              # runs tests/rewards_vault.ts against a local validator

# 4. Deploy (mainnet). Fund the deploy wallet with SOL first (~a few SOL of rent).
solana config set --url mainnet-beta
anchor deploy --provider.cluster mainnet
#   → prints the program id; keep it, it is the vault "address"

# 5. Initialise the vault (owner + treasury), then enable the operator:
#    call `initialize(owner, treasury)` and `set_operator_enable(operator)`
#    with a small client script or `anchor run`.
```

> The `declare_id!` in `programs/rewards_vault/src/lib.rs` and the ids in
> `Anchor.toml` are placeholders — `anchor keys sync` rewrites them from the
> keypair in `target/deploy/rewards_vault-keypair.json`.

## Deployment parameters (fill in before `initialize`)

| Param | Value |
|---|---|
| **owner** | `366sLirZUpwnmKygmLG1PT6LqaAPhmvrxnEeANpZuC8z` |
| **treasury** | `366sLirZUpwnmKygmLG1PT6LqaAPhmvrxnEeANpZuC8z` (same wallet; validated 32-byte, on-curve) |
| **operator** | `HpnhA2fQorhjwegXCgP1Z4QvUwk5N8wLM5HynaEo86LP` (pubkey; validated 32-byte, on-curve — set after init via `set_operator_enable`. Its SECRET goes only into the bot's Railway env at wiring time, never in chat.) |

`initialize(owner, treasury)` is called once at deploy. Here owner == treasury:
one wallet both controls the vault (setOperator / setTreasury / transferOwnership
/ withdraw / setMinClaim) and receives the team slice. `treasury` is where
`withdraw_treasury` always sends the team slice regardless of who signs; either
can be changed later (owner-only).

> ⚠️ Whoever holds this key holds FULL vault authority. Make sure
> `366sLir…uC8z` is **NOT** derived from the 24-word seed that was pasted in chat
> (that seed is compromised) — if it is, generate a clean wallet and use its
> pubkey instead before mainnet.

## Bot integration (after deploy)

Mirror the EVM wiring in `buytechsniper`:

- **Fee attribution at settle** (like `attributeVaultFee`): when a Solana trade
  confirms, the operator signs `deposit_fee(trader, cashbackBps, feeLamports)`,
  passing the trader's `RewardAccount` PDA and — when the trader has a referrer —
  the referrer's `RewardAccount` PDA. Register referrers with `set_referrer` the
  first time (write-once).
- **Claim UI**: `claim_cashback` / `claim_referral` are signed by the user's own
  Solana wallet (they pay their own tx fee), exactly like the EVM claim path
  where the operator is never involved.
- **Env**: add e.g. `VAULT_SOLANA=<program id>` and reuse the existing
  `REWARDS_OPERATOR_KEY` model (a Solana operator keypair). Fee attribution stays
  inert until both are set — same gating as EVM.
- **Amounts** are in lamports (1 SOL = 1e9), and the fee token is native SOL.

## Layout

```
programs/rewards_vault/src/lib.rs   the program
tests/rewards_vault.ts              happy-path + invariant test
Anchor.toml  Cargo.toml  package.json  tsconfig.json
```

## Known follow-ups before mainnet

- Compile & run the test suite (never done here); fix any Anchor 0.30 API drift.
- Add adversarial tests: non-operator deposit, self-referral, double-claim,
  below-min-claim, withdraw by a non-owner/treasury, overflow at large volumes.
- Decide `sync_treasury` policy — it assumes no outstanding user balances; either
  restrict it to pre-launch reconciliation or drop it.
- Consider a compute-budget check on `deposit_fee` (init_if_needed of two reward
  accounts in one ix).
- Security review of the direct-lamport payout path and rent math.
