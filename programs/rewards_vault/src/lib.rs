//! RewardsVault (Solana / Anchor) — on-chain split + custody of the bot's 1%
//! trading fee, ported 1:1 from the EVM `RewardsVault.sol`.
//!
//! THE MODEL. The bot takes 1% of every trade and deposits it here tagged with
//! the trader. On arrival the fee is split three ways, in native SOL (lamports):
//!   - referral: a FIXED 25% to whoever referred the trader (0 if none, which
//!     leaves that slice with the team);
//!   - cashback: the trader's TIER rate (0%..25%, clamped on-chain) back to them;
//!   - team:     the remainder, accrued to `treasury_owed`.
//! Referral and cashback accrue as per-user balances that the user pulls out
//! themselves; the team slice accrues to the treasury balance.
//!
//! THE ONE INVARIANT EVERYTHING RESTS ON. Every lamport that enters `deposit_fee`
//! is assigned to exactly one of {referral, cashback, treasury_owed}, so
//!
//!     config.lamports - rent_exempt_minimum
//!         == sum(referral_owed) + sum(cashback_owed) + treasury_owed
//!
//! holds after every call. A claim or a treasury withdrawal decrements exactly
//! the owed it pays out and the same lamports. It is therefore impossible for the
//! vault to owe more than it holds, or to pay anyone from money it did not
//! receive. There is deliberately no admin "rescue" that could touch user
//! balances and break it.
//!
//! THE TRUST SURFACE. The cashback RATE is supplied by the operator (the tier is
//! cross-chain and cannot be known on one chain), so a dishonest operator could
//! pay a trader a higher cashback than their tier — but ONLY up to 25%, and ONLY
//! out of the fee actually deposited, so it can never create insolvency or pay
//! from thin air. `set_referrer` is operator-only and WRITE-ONCE, so a referral
//! relationship can never be rewired after the fact.
//!
//! SOLANA NOTES. Funds and state live together in the program-owned `Config` PDA;
//! payouts debit its lamports directly (allowed because the program owns it) and
//! always leave it rent-exempt — guaranteed by the invariant, and re-checked.
//! There is no reentrancy in Solana's execution model (no synchronous callback
//! into the program mid-instruction), but every handler still follows
//! checks-effects-interactions. Unattributed SOL sent straight to the PDA simply
//! over-collateralises the vault and is never withdrawable — the safe failure mode.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("DSos54UeW6KKYN7oS6egEibNWxMRDxFYrUEnhVbys7oG");

const BPS_DENOMINATOR: u64 = 10_000;
/// Referral is a flat 25% of the fee, never tier-dependent.
const REFERRAL_BPS: u64 = 2_500;
/// Cashback can never exceed the top tier's 25%, whatever the operator passes.
const MAX_CASHBACK_BPS: u16 = 2_500;

const CONFIG_SEED: &[u8] = b"config";
const OPERATOR_SEED: &[u8] = b"operator";
const REWARD_SEED: &[u8] = b"reward";

#[program]
pub mod rewards_vault {
    use super::*;

    /// Create the vault. Mirrors the EVM constructor(owner, treasury, operator).
    /// The `payer` funds the account rent; `owner` and `treasury` are set from
    /// args; an initial operator is created if `operator` is not the default key.
    pub fn initialize(
        ctx: Context<Initialize>,
        owner: Pubkey,
        treasury: Pubkey,
    ) -> Result<()> {
        require!(owner != Pubkey::default(), VaultError::ZeroAddress);
        require!(treasury != Pubkey::default(), VaultError::ZeroAddress);

        let config = &mut ctx.accounts.config;
        config.owner = owner;
        config.pending_owner = Pubkey::default();
        config.treasury = treasury;
        config.min_claim_lamports = 0;
        config.treasury_owed = 0;
        config.treasury_claimed = 0;
        config.bump = ctx.bumps.config;

        emit!(OwnershipTransferred { from: Pubkey::default(), to: owner });
        emit!(TreasurySet { treasury });
        Ok(())
    }

    /// onlyOwner: enable an operator by creating its marker PDA.
    pub fn set_operator_enable(ctx: Context<SetOperatorEnable>, operator: Pubkey) -> Result<()> {
        require_keys_eq!(ctx.accounts.owner.key(), ctx.accounts.config.owner, VaultError::NotOwner);
        require!(operator != Pubkey::default(), VaultError::ZeroAddress);
        ctx.accounts.operator_pda.bump = ctx.bumps.operator_pda;
        emit!(OperatorSet { operator, allowed: true });
        Ok(())
    }

    /// onlyOwner: disable an operator by closing its marker PDA (rent → owner).
    pub fn set_operator_disable(ctx: Context<SetOperatorDisable>, operator: Pubkey) -> Result<()> {
        require_keys_eq!(ctx.accounts.owner.key(), ctx.accounts.config.owner, VaultError::NotOwner);
        emit!(OperatorSet { operator, allowed: false });
        Ok(())
    }

    /// onlyOperator, WRITE-ONCE. Register `trader`'s referrer. Creates both reward
    /// accounts if needed, so referral can later accrue to the referrer.
    pub fn set_referrer(ctx: Context<SetReferrer>, trader: Pubkey, referrer: Pubkey) -> Result<()> {
        require!(trader != Pubkey::default(), VaultError::ZeroAddress);
        require!(referrer != Pubkey::default(), VaultError::ZeroAddress);
        require!(trader != referrer, VaultError::SelfReferral);

        let tr = &mut ctx.accounts.trader_reward;
        // Freshly-created accounts come zeroed → referrer == default().
        if tr.bump == 0 {
            tr.bump = ctx.bumps.trader_reward;
        }
        require!(tr.referrer == Pubkey::default(), VaultError::ReferrerAlreadySet);
        tr.referrer = referrer;

        let rr = &mut ctx.accounts.referrer_reward;
        if rr.bump == 0 {
            rr.bump = ctx.bumps.referrer_reward;
        }

        emit!(ReferrerSet { trader, referrer });
        Ok(())
    }

    /// onlyOperator, payable. Take one trade's fee (`amount` lamports) and split
    /// it. `referrer_reward` must be supplied (and match) iff the trader has a
    /// referrer on file; otherwise that slice falls to the treasury.
    pub fn deposit_fee(
        ctx: Context<DepositFee>,
        trader: Pubkey,
        cashback_bps: u16,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, VaultError::ZeroValue);
        require!(trader != Pubkey::default(), VaultError::ZeroAddress);

        let tr = &mut ctx.accounts.trader_reward;
        if tr.bump == 0 {
            tr.bump = ctx.bumps.trader_reward;
        }

        let cb_bps = core::cmp::min(cashback_bps, MAX_CASHBACK_BPS) as u64;
        let referrer = tr.referrer;

        // Split (remainder-based, sums to EXACTLY `amount`, no rounding leak).
        let referral_amount = if referrer == Pubkey::default() {
            0u64
        } else {
            (amount as u128 * REFERRAL_BPS as u128 / BPS_DENOMINATOR as u128) as u64
        };
        let cashback_amount = (amount as u128 * cb_bps as u128 / BPS_DENOMINATOR as u128) as u64;
        // referral + cashback <= 50% of amount, so this never underflows.
        let treasury_amount = amount - referral_amount - cashback_amount;

        // Pull the fee into the vault (operator → config) BEFORE crediting owed.
        system_program::transfer(
            CpiContext::new(
                // Anchor 1.x: CpiContext::new takes the program's Pubkey, not its
                // AccountInfo. The transfer helper invokes with from+to only.
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.operator.to_account_info(),
                    to: ctx.accounts.config.to_account_info(),
                },
            ),
            amount,
        )?;

        // Credit referral to the referrer's account, if any.
        if referral_amount > 0 {
            let rr = ctx
                .accounts
                .referrer_reward
                .as_mut()
                .ok_or(VaultError::ReferrerAccountMissing)?;
            // The passed account must be the referrer's canonical reward PDA.
            let (expected, _) =
                Pubkey::find_program_address(&[REWARD_SEED, referrer.as_ref()], ctx.program_id);
            require_keys_eq!(rr.key(), expected, VaultError::ReferrerAccountMismatch);
            rr.referral_owed = rr.referral_owed.checked_add(referral_amount).unwrap();
        }
        if cashback_amount > 0 {
            tr.cashback_owed = tr.cashback_owed.checked_add(cashback_amount).unwrap();
        }
        let config = &mut ctx.accounts.config;
        config.treasury_owed = config.treasury_owed.checked_add(treasury_amount).unwrap();

        emit!(FeeDeposited {
            trader,
            referrer,
            amount,
            referral_amount,
            cashback_amount,
            treasury_amount,
            cashback_bps: cb_bps as u16,
        });
        Ok(())
    }

    /// Pull the caller's accrued cashback.
    pub fn claim_cashback(ctx: Context<Claim>) -> Result<()> {
        let amount = ctx.accounts.reward.cashback_owed;
        require!(amount > 0, VaultError::NothingToClaim);
        require!(amount >= ctx.accounts.config.min_claim_lamports, VaultError::BelowMinClaim);

        // Effects before interaction.
        ctx.accounts.reward.cashback_owed = 0;
        ctx.accounts.reward.cashback_claimed =
            ctx.accounts.reward.cashback_claimed.checked_add(amount).unwrap();

        pay_from_config(
            &ctx.accounts.config.to_account_info(),
            &ctx.accounts.user.to_account_info(),
            amount,
        )?;
        emit!(CashbackClaimed { user: ctx.accounts.user.key(), amount });
        Ok(())
    }

    /// Pull the caller's accrued referral.
    pub fn claim_referral(ctx: Context<Claim>) -> Result<()> {
        let amount = ctx.accounts.reward.referral_owed;
        require!(amount > 0, VaultError::NothingToClaim);
        require!(amount >= ctx.accounts.config.min_claim_lamports, VaultError::BelowMinClaim);

        ctx.accounts.reward.referral_owed = 0;
        ctx.accounts.reward.referral_claimed =
            ctx.accounts.reward.referral_claimed.checked_add(amount).unwrap();

        pay_from_config(
            &ctx.accounts.config.to_account_info(),
            &ctx.accounts.user.to_account_info(),
            amount,
        )?;
        emit!(ReferralClaimed { user: ctx.accounts.user.key(), amount });
        Ok(())
    }

    /// owner OR treasury may withdraw up to `treasury_owed` — always to the
    /// treasury address, whoever signs.
    pub fn withdraw_treasury(ctx: Context<WithdrawTreasury>, amount: u64) -> Result<()> {
        let config = &ctx.accounts.config;
        let signer = ctx.accounts.authority.key();
        require!(signer == config.owner || signer == config.treasury, VaultError::NotOwner);
        require!(amount <= config.treasury_owed, VaultError::InsufficientTreasury);
        require_keys_eq!(ctx.accounts.treasury.key(), config.treasury, VaultError::TreasuryMismatch);

        let config = &mut ctx.accounts.config;
        config.treasury_owed -= amount;
        config.treasury_claimed = config.treasury_claimed.checked_add(amount).unwrap();

        pay_from_config(
            &ctx.accounts.config.to_account_info(),
            &ctx.accounts.treasury.to_account_info(),
            amount,
        )?;
        emit!(TreasuryWithdrawn { to: ctx.accounts.treasury.key(), amount });
        Ok(())
    }

    // ── Admin ────────────────────────────────────────────────────────────────
    pub fn set_treasury(ctx: Context<OnlyOwner>, treasury: Pubkey) -> Result<()> {
        require_keys_eq!(ctx.accounts.owner.key(), ctx.accounts.config.owner, VaultError::NotOwner);
        require!(treasury != Pubkey::default(), VaultError::ZeroAddress);
        ctx.accounts.config.treasury = treasury;
        emit!(TreasurySet { treasury });
        Ok(())
    }

    pub fn set_min_claim(ctx: Context<OnlyOwner>, min_claim_lamports: u64) -> Result<()> {
        require_keys_eq!(ctx.accounts.owner.key(), ctx.accounts.config.owner, VaultError::NotOwner);
        ctx.accounts.config.min_claim_lamports = min_claim_lamports;
        emit!(MinClaimSet { min_claim_lamports });
        Ok(())
    }

    pub fn transfer_ownership(ctx: Context<OnlyOwner>, new_owner: Pubkey) -> Result<()> {
        require_keys_eq!(ctx.accounts.owner.key(), ctx.accounts.config.owner, VaultError::NotOwner);
        require!(new_owner != Pubkey::default(), VaultError::ZeroAddress);
        ctx.accounts.config.pending_owner = new_owner;
        emit!(OwnershipTransferStarted { from: ctx.accounts.config.owner, to: new_owner });
        Ok(())
    }

    pub fn accept_ownership(ctx: Context<AcceptOwnership>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require_keys_eq!(ctx.accounts.new_owner.key(), config.pending_owner, VaultError::NotOwner);
        let old = config.owner;
        config.owner = config.pending_owner;
        config.pending_owner = Pubkey::default();
        emit!(OwnershipTransferred { from: old, to: config.owner });
        Ok(())
    }

    // NOTE: there is deliberately NO admin function that can move lamports the vault
    // does not track as treasury_owed. An earlier `sync_treasury` could, if misused,
    // fold user-owed balances into the treasury — a privilege footgun — so it was
    // removed. Unattributed SOL sent straight to the PDA simply over-collateralises
    // the vault and is never withdrawable, which is the safe failure mode.
}

/// Debit lamports from the program-owned `config` PDA to `to`, keeping the PDA
/// rent-exempt. Direct lamport manipulation is permitted because this program
/// owns `config`; the rent check makes an accounting bug fail loudly instead of
/// purging the account.
fn pay_from_config<'info>(
    config: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let rent = Rent::get()?.minimum_balance(config.data_len());
    let from_balance = config.lamports();
    require!(from_balance >= amount, VaultError::InsufficientVault);
    require!(from_balance - amount >= rent, VaultError::WouldBreakRent);

    **config.try_borrow_mut_lamports()? = from_balance - amount;
    **to.try_borrow_mut_lamports()? = to.lamports().checked_add(amount).unwrap();
    Ok(())
}

// ── Accounts ─────────────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub owner: Pubkey,
    pub pending_owner: Pubkey,
    pub treasury: Pubkey,
    pub min_claim_lamports: u64,
    pub treasury_owed: u64,
    pub treasury_claimed: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Operator {
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RewardAccount {
    /// Write-once referrer of the owner of this account. default() = none.
    pub referrer: Pubkey,
    pub cashback_owed: u64,
    pub cashback_claimed: u64,
    pub referral_owed: u64,
    pub referral_claimed: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(operator: Pubkey)]
pub struct SetOperatorEnable<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Operator::INIT_SPACE,
        seeds = [OPERATOR_SEED, operator.as_ref()],
        bump
    )]
    pub operator_pda: Account<'info, Operator>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(operator: Pubkey)]
pub struct SetOperatorDisable<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        close = owner,
        seeds = [OPERATOR_SEED, operator.as_ref()],
        bump = operator_pda.bump
    )]
    pub operator_pda: Account<'info, Operator>,
}

#[derive(Accounts)]
#[instruction(trader: Pubkey, referrer: Pubkey)]
pub struct SetReferrer<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(seeds = [OPERATOR_SEED, operator.key().as_ref()], bump = operator_pda.bump)]
    pub operator_pda: Account<'info, Operator>,
    #[account(
        init_if_needed,
        payer = operator,
        space = 8 + RewardAccount::INIT_SPACE,
        seeds = [REWARD_SEED, trader.as_ref()],
        bump
    )]
    pub trader_reward: Account<'info, RewardAccount>,
    #[account(
        init_if_needed,
        payer = operator,
        space = 8 + RewardAccount::INIT_SPACE,
        seeds = [REWARD_SEED, referrer.as_ref()],
        bump
    )]
    pub referrer_reward: Account<'info, RewardAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(trader: Pubkey)]
pub struct DepositFee<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(seeds = [OPERATOR_SEED, operator.key().as_ref()], bump = operator_pda.bump)]
    pub operator_pda: Account<'info, Operator>,
    #[account(
        init_if_needed,
        payer = operator,
        space = 8 + RewardAccount::INIT_SPACE,
        seeds = [REWARD_SEED, trader.as_ref()],
        bump
    )]
    pub trader_reward: Account<'info, RewardAccount>,
    /// Required (and validated) only when the trader has a referrer on file.
    #[account(mut)]
    pub referrer_reward: Option<Account<'info, RewardAccount>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [REWARD_SEED, user.key().as_ref()],
        bump = reward.bump
    )]
    pub reward: Account<'info, RewardAccount>,
}

#[derive(Accounts)]
pub struct WithdrawTreasury<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
    /// CHECK: must equal config.treasury (checked in the handler); receives SOL.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct OnlyOwner<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptOwnership<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub new_owner: Signer<'info>,
}

// ── Events ───────────────────────────────────────────────────────────────────
#[event]
pub struct FeeDeposited {
    pub trader: Pubkey,
    pub referrer: Pubkey,
    pub amount: u64,
    pub referral_amount: u64,
    pub cashback_amount: u64,
    pub treasury_amount: u64,
    pub cashback_bps: u16,
}
#[event]
pub struct ReferrerSet {
    pub trader: Pubkey,
    pub referrer: Pubkey,
}
#[event]
pub struct CashbackClaimed {
    pub user: Pubkey,
    pub amount: u64,
}
#[event]
pub struct ReferralClaimed {
    pub user: Pubkey,
    pub amount: u64,
}
#[event]
pub struct TreasuryWithdrawn {
    pub to: Pubkey,
    pub amount: u64,
}
#[event]
pub struct OperatorSet {
    pub operator: Pubkey,
    pub allowed: bool,
}
#[event]
pub struct TreasurySet {
    pub treasury: Pubkey,
}
#[event]
pub struct MinClaimSet {
    pub min_claim_lamports: u64,
}
#[event]
pub struct OwnershipTransferStarted {
    pub from: Pubkey,
    pub to: Pubkey,
}
#[event]
pub struct OwnershipTransferred {
    pub from: Pubkey,
    pub to: Pubkey,
}

// ── Errors ───────────────────────────────────────────────────────────────────
#[error_code]
pub enum VaultError {
    #[msg("caller is not the owner")]
    NotOwner,
    #[msg("caller is not an operator")]
    NotOperator,
    #[msg("zero address")]
    ZeroAddress,
    #[msg("zero value")]
    ZeroValue,
    #[msg("self referral")]
    SelfReferral,
    #[msg("referrer already set")]
    ReferrerAlreadySet,
    #[msg("nothing to claim")]
    NothingToClaim,
    #[msg("below minimum claim")]
    BelowMinClaim,
    #[msg("insufficient treasury")]
    InsufficientTreasury,
    #[msg("treasury account mismatch")]
    TreasuryMismatch,
    #[msg("referrer reward account missing")]
    ReferrerAccountMissing,
    #[msg("referrer reward account mismatch")]
    ReferrerAccountMismatch,
    #[msg("insufficient vault balance")]
    InsufficientVault,
    #[msg("transfer would break rent-exemption")]
    WouldBreakRent,
}
