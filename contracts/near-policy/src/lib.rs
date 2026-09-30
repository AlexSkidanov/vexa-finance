//! # Vexa agent policies
//!
//! An agent is a sub-account an owner gives to software, such as an AI agent
//! paying for APIs. Its Solana key is an MPC key held by the NEAR network
//! (`v1.signer`), derived for this contract and the path `vexa-agent-{id}`.
//! Nobody has the private key; the only way to get a signature is to ask this
//! contract, and it only asks the MPC network after the transaction passes the
//! agent's policy:
//!
//! - a maximum per payment and a rolling 24-hour limit, checked on the
//!   payment's hidden amount (see [`zk`]);
//! - an allow-list of recipients and of domains (for x402 payments);
//! - pause and revoke, by the owner.
//!
//! Owners authorize policy changes with the Ed25519 key of their Solana wallet,
//! so the Vexa API, which relays calls and pays for gas and storage, can't
//! change a policy. Payments are authorized by the agent's own `authority` key
//! (held by the agent software) or by the owner.
//!
//! Every error message starts with a stable code, e.g. `RECIPIENT_NOT_ALLOWED:`.

mod derive;
pub mod solana;
pub mod zk;

#[cfg(test)]
mod tests;

use near_sdk::{
    env, ext_contract,
    json_types::{Base64VecU8, U64},
    near, require,
    store::LookupMap,
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
};

use solana::{Instruction, Pubkey};

const DAY_MS: u64 = 24 * 60 * 60 * 1000;
/// Payments tracked per agent at once. Bounds storage and the gas of summing
/// the window; an agent at the cap waits for its oldest payment to age out.
pub const MAX_WINDOW: usize = 128;
/// `v1.signer` domain for Ed25519 (Frost) on mainnet and testnet.
const ED25519_DOMAIN: u32 = 1;
const SIGN_GAS: Gas = Gas::from_tgas(15);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);

// Instruction bytes the contract recognizes.
const SYSTEM_TRANSFER: [u8; 4] = [2, 0, 0, 0];
const SYSTEM_ADVANCE_NONCE: [u8; 4] = [4, 0, 0, 0];
const TOKEN_CONFIDENTIAL: u8 = 27;
const CT_TRANSFER: u8 = 7;
const CT_APPLY_PENDING: u8 = 8;
const CT_TRANSFER_DATA_LEN: usize = 2 + 36 + 64 + 64 + 3;
const ZK_CLOSE_CONTEXT: u8 = 0;
const ZK_VERIFY_PUBKEY_VALIDITY: u8 = 4;
const VAULT_CONFIGURE: u8 = 1;
const VAULT_REQUIRE_CONTEXTS: u8 = 9;

fn fail(code: &str, detail: impl AsRef<str>) -> ! {
    env::panic_str(&format!("{code}: {}", detail.as_ref()))
}

fn key(s: &str, what: &str) -> Pubkey {
    solana::decode(s)
        .unwrap_or_else(|| fail("INVALID_ARGUMENT", format!("{what} is not a base58 key")))
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    /// USDC base units (6 decimals).
    pub max_per_request: U64,
    /// USDC base units per rolling 24 hours.
    pub daily_limit: U64,
    /// cUSDC accounts the agent may pay, base58. Empty means any.
    pub allowed_recipients: Vec<String>,
    /// Domains the agent may pay for (x402). Empty means any.
    pub allowed_domains: Vec<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Status {
    Active,
    Paused,
    Revoked,
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Signer {
    Agent,
    Owner,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Spend {
    pub at_ms: u64,
    pub index: u64,
    /// The payment's amount commitment, compressed Ristretto.
    pub commitment: [u8; 32],
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Agent {
    pub owner: Pubkey,
    pub owner_cusdc: Pubkey,
    pub authority: Pubkey,
    pub address: Pubkey,
    pub cusdc: Pubkey,
    pub nonce_account: Pubkey,
    pub policy: Policy,
    recipients: Vec<Pubkey>,
    pub status: Status,
    /// Bumped by every owner- or agent-authorized call; signatures cover it.
    pub auth_nonce: u64,
    /// The next payment index. Payment openings are derived from it, so an
    /// index is never reused.
    pub next_index: u64,
    pub window: Vec<Spend>,
}

#[near(serializers = [json])]
pub struct SpendView {
    pub at_ms: U64,
    pub index: U64,
    pub commitment: String,
}

#[near(serializers = [json])]
pub struct AgentView {
    pub address: String,
    pub cusdc: String,
    pub owner: String,
    pub owner_cusdc: String,
    pub authority: String,
    pub nonce_account: String,
    pub policy: Policy,
    pub status: Status,
    pub auth_nonce: U64,
    pub next_index: U64,
    pub window: Vec<SpendView>,
}

#[near(serializers = [json])]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u32,
}

#[near(serializers = [json])]
pub enum Payload {
    Eddsa(String),
}

#[near(serializers = [json])]
pub struct SignatureResponse {
    pub scheme: String,
    pub signature: Vec<u8>,
}

#[ext_contract(ext_mpc)]
#[allow(dead_code)]
trait MpcSigner {
    fn sign(&mut self, request: SignRequest);
}

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Agents,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    /// The Vexa API's NEAR account: the only caller. It pays gas and storage.
    relayer: AccountId,
    mpc: AccountId,
    mpc_root: Pubkey,
    vault_program: Pubkey,
    cusdc_mint: Pubkey,
    /// Vexa's Solana fee payer: the first signer of every agent transaction.
    fee_payer: Pubkey,
    agents: LookupMap<String, Agent>,
}

/// What an agent transaction does, once checked.
enum Action {
    /// A payment within policy: record it in the window.
    Payment { index: u64, commitment: [u8; 32] },
    /// Anything that moves no value out of the agent's account.
    Maintenance,
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        relayer: AccountId,
        mpc: AccountId,
        mpc_root: String,
        vault_program: String,
        cusdc_mint: String,
        fee_payer: String,
    ) -> Self {
        Self {
            relayer,
            mpc,
            mpc_root: key(mpc_root.trim_start_matches("ed25519:"), "mpc_root"),
            vault_program: key(&vault_program, "vault_program"),
            cusdc_mint: key(&cusdc_mint, "cusdc_mint"),
            fee_payer: key(&fee_payer, "fee_payer"),
            agents: LookupMap::new(StorageKey::Agents),
        }
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    /// The Solana address an agent id derives to, whether or not it exists yet.
    pub fn agent_address(&self, agent_id: String) -> String {
        solana::encode(&self.derive(&agent_id))
    }

    pub fn get_agent(&self, agent_id: String) -> Option<AgentView> {
        self.agents.get(&agent_id).map(|a| AgentView {
            address: solana::encode(&a.address),
            cusdc: solana::encode(&a.cusdc),
            owner: solana::encode(&a.owner),
            owner_cusdc: solana::encode(&a.owner_cusdc),
            authority: solana::encode(&a.authority),
            nonce_account: solana::encode(&a.nonce_account),
            policy: a.policy.clone(),
            status: a.status,
            auth_nonce: U64(a.auth_nonce),
            next_index: U64(a.next_index),
            window: a
                .window
                .iter()
                .map(|s| SpendView {
                    at_ms: U64(s.at_ms),
                    index: U64(s.index),
                    commitment: hex::encode(s.commitment),
                })
                .collect(),
        })
    }

    /// The exact bytes an owner or agent signs to authorize `action`.
    pub fn authorization_message(
        &self,
        action: String,
        agent_id: String,
        nonce: U64,
        payload: Base64VecU8,
    ) -> String {
        String::from_utf8(self.auth_message(&action, &agent_id, nonce.0, &payload.0)).unwrap()
    }

    // -----------------------------------------------------------------------
    // Policies, authorized by the owner's Solana key
    // -----------------------------------------------------------------------

    /// Registers an agent. `signature` is the owner's over
    /// `authorization_message("create", agent_id, 0, borsh(policy) ‖ authority ‖ nonce_account)`.
    /// The relayer attaches the storage deposit; the excess is refunded.
    #[payable]
    pub fn create_policy(
        &mut self,
        agent_id: String,
        owner: String,
        authority: String,
        nonce_account: String,
        policy: Policy,
        signature: Base64VecU8,
    ) -> String {
        self.only_relayer();
        require!(!self.agents.contains_key(&agent_id), "AGENT_EXISTS: agent id already used");
        require!(
            !agent_id.is_empty() && agent_id.len() <= 64,
            "INVALID_ARGUMENT: agent id must be 1 to 64 characters"
        );
        let owner = key(&owner, "owner");
        let authority = key(&authority, "authority");
        let nonce_account = key(&nonce_account, "nonce_account");
        let recipients = Self::recipients(&policy);

        let mut payload = near_sdk::borsh::to_vec(&policy).unwrap();
        payload.extend_from_slice(&authority);
        payload.extend_from_slice(&nonce_account);
        self.verify(&owner, "create", &agent_id, 0, &payload, &signature.0);

        let start = env::storage_usage();
        let address = self.derive(&agent_id);
        self.agents.insert(
            agent_id,
            Agent {
                owner,
                owner_cusdc: solana::associated_token_2022_account(&owner, &self.cusdc_mint),
                authority,
                address,
                cusdc: solana::associated_token_2022_account(&address, &self.cusdc_mint),
                nonce_account,
                policy,
                recipients,
                status: Status::Active,
                auth_nonce: 1,
                next_index: 0,
                window: Vec::new(),
            },
        );
        self.agents.flush();
        self.charge_storage(start);
        solana::encode(&address)
    }

    /// Replaces an agent's policy. Signed by the owner over
    /// `authorization_message("update_policy", agent_id, nonce, borsh(policy))`.
    pub fn update_policy(
        &mut self,
        agent_id: String,
        policy: Policy,
        nonce: U64,
        signature: Base64VecU8,
    ) {
        self.only_relayer();
        let mut agent = self.agent(&agent_id);
        require!(agent.status != Status::Revoked, "AGENT_REVOKED: the agent is revoked");
        let payload = near_sdk::borsh::to_vec(&policy).unwrap();
        self.verify_owner(&agent, "update_policy", &agent_id, nonce.0, &payload, &signature.0);
        agent.recipients = Self::recipients(&policy);
        agent.policy = policy;
        agent.auth_nonce += 1;
        self.agents.insert(agent_id, agent);
    }

    /// Pauses (`true`) or resumes an agent. Signed by the owner over
    /// `authorization_message("set_paused", agent_id, nonce, [paused])`.
    pub fn set_paused(
        &mut self,
        agent_id: String,
        paused: bool,
        nonce: U64,
        signature: Base64VecU8,
    ) {
        self.only_relayer();
        let mut agent = self.agent(&agent_id);
        require!(agent.status != Status::Revoked, "AGENT_REVOKED: the agent is revoked");
        self.verify_owner(&agent, "set_paused", &agent_id, nonce.0, &[paused as u8], &signature.0);
        agent.status = if paused { Status::Paused } else { Status::Active };
        agent.auth_nonce += 1;
        self.agents.insert(agent_id, agent);
    }

    /// Revokes an agent for good. It can still send what it holds back to the
    /// owner. Signed by the owner over `authorization_message("revoke_policy", agent_id, nonce, [])`.
    pub fn revoke_policy(&mut self, agent_id: String, nonce: U64, signature: Base64VecU8) {
        self.only_relayer();
        let mut agent = self.agent(&agent_id);
        self.verify_owner(&agent, "revoke_policy", &agent_id, nonce.0, &[], &signature.0);
        agent.status = Status::Revoked;
        agent.auth_nonce += 1;
        self.agents.insert(agent_id, agent);
    }

    /// Hands the agent's authority to a new key (the agent software rotated
    /// it, or the owner is cutting a compromised one off). Owner-signed over
    /// `authorization_message("set_authority", agent_id, nonce, authority)`.
    pub fn set_authority(
        &mut self,
        agent_id: String,
        authority: String,
        nonce: U64,
        signature: Base64VecU8,
    ) {
        self.only_relayer();
        let mut agent = self.agent(&agent_id);
        let authority = key(&authority, "authority");
        self.verify_owner(&agent, "set_authority", &agent_id, nonce.0, &authority, &signature.0);
        agent.authority = authority;
        agent.auth_nonce += 1;
        self.agents.insert(agent_id, agent);
    }

    // -----------------------------------------------------------------------
    // Signing
    // -----------------------------------------------------------------------

    /// Checks an agent's Solana transaction against its policy and, if it
    /// passes, asks the MPC network to sign it. Resolves to the 64-byte
    /// Ed25519 signature (hex), or `null` if the MPC network failed.
    ///
    /// - `message`: the serialized transaction message to sign.
    /// - `validity`, `limit`: for payments, the `proof_type ‖ context` bytes of
    ///   the transfer's validity proof and of its limit proof.
    /// - `index`: the payment index (`next_index`); `window_start`: the lowest
    ///   index the limit proof's window includes.
    /// - `signature`: by the agent's authority (or the owner) over
    ///   `authorization_message("sign", agent_id, nonce, message ‖ index ‖ window_start ‖ domain)`.
    ///
    /// Attach at least 0.001 NEAR: 1 yoctoNEAR goes to the MPC signer and the
    /// rest covers the storage of the payment record.
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn request_signature(
        &mut self,
        agent_id: String,
        message: Base64VecU8,
        validity: Option<Base64VecU8>,
        limit: Option<Base64VecU8>,
        index: Option<U64>,
        window_start: Option<U64>,
        domain: Option<String>,
        signer: Signer,
        nonce: U64,
        signature: Base64VecU8,
    ) -> Promise {
        self.only_relayer();
        require!(
            env::attached_deposit() >= NearToken::from_millinear(1),
            "INSUFFICIENT_DEPOSIT: attach 0.001 NEAR"
        );
        let mut agent = self.agent(&agent_id);

        let index_bytes = index.map_or(u64::MAX, |i| i.0).to_le_bytes();
        let start_bytes = window_start.map_or(u64::MAX, |i| i.0).to_le_bytes();
        let mut payload = message.0.clone();
        payload.extend_from_slice(&index_bytes);
        payload.extend_from_slice(&start_bytes);
        payload.extend_from_slice(domain.as_deref().unwrap_or("").as_bytes());
        let signer_key = match signer {
            Signer::Agent => agent.authority,
            Signer::Owner => agent.owner,
        };
        require!(nonce.0 == agent.auth_nonce, "STALE_NONCE: use the agent's current auth_nonce");
        self.verify(&signer_key, "sign", &agent_id, nonce.0, &payload, &signature.0);
        agent.auth_nonce += 1;

        let parsed =
            solana::parse_message(&message.0).unwrap_or_else(|e| fail("BAD_TRANSACTION", e));
        let action = self.check(
            &agent,
            &parsed.instructions,
            &parsed.signers,
            PaymentProofs {
                validity: validity.as_ref().map(|v| v.0.as_slice()),
                limit: limit.as_ref().map(|v| v.0.as_slice()),
                index: index.map(|i| i.0),
                window_start: window_start.map(|i| i.0),
                domain: domain.as_deref(),
            },
        );

        let recorded = match action {
            Action::Payment { index, commitment } => {
                let now = env::block_timestamp_ms();
                agent.window.retain(|s| s.at_ms + DAY_MS > now);
                require!(
                    agent.window.len() < MAX_WINDOW,
                    "WINDOW_FULL: too many payments in 24 hours"
                );
                agent.window.push(Spend { at_ms: now, index, commitment });
                agent.next_index = index + 1;
                Some(index)
            }
            Action::Maintenance => None,
        };
        self.agents.insert(agent_id.clone(), agent);

        ext_mpc::ext(self.mpc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(SIGN_GAS)
            .with_unused_gas_weight(0)
            .sign(SignRequest {
                path: derive::agent_path(&agent_id),
                payload_v2: Payload::Eddsa(hex::encode(&message.0)),
                domain_id: ED25519_DOMAIN,
            })
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_signature(agent_id, recorded.map(U64)),
            )
    }

    /// The MPC response. If signing failed, the payment is taken back out of
    /// the window: nothing was signed, so nothing can be spent.
    #[private]
    pub fn on_signature(
        &mut self,
        agent_id: String,
        index: Option<U64>,
        #[callback_result] result: Result<SignatureResponse, PromiseError>,
    ) -> Option<String> {
        match result {
            Ok(response) if response.scheme == "Ed25519" && response.signature.len() == 64 => {
                Some(hex::encode(response.signature))
            }
            _ => {
                if let (Some(index), Some(mut agent)) = (index, self.agents.get(&agent_id).cloned())
                {
                    agent.window.retain(|s| s.index != index.0);
                    self.agents.insert(agent_id, agent);
                }
                None
            }
        }
    }

    // -----------------------------------------------------------------------
    // Administration, by the relayer
    // -----------------------------------------------------------------------

    pub fn set_relayer(&mut self, relayer: AccountId) {
        self.only_relayer();
        self.relayer = relayer;
    }

    pub fn set_fee_payer(&mut self, fee_payer: String) {
        self.only_relayer();
        self.fee_payer = key(&fee_payer, "fee_payer");
    }
}

/// The proofs and parameters that accompany a payment.
struct PaymentProofs<'a> {
    validity: Option<&'a [u8]>,
    limit: Option<&'a [u8]>,
    index: Option<u64>,
    window_start: Option<u64>,
    domain: Option<&'a str>,
}

impl Contract {
    fn only_relayer(&self) {
        require!(
            env::predecessor_account_id() == self.relayer,
            "NOT_RELAYER: only the Vexa relayer may call this"
        );
    }

    fn agent(&self, agent_id: &str) -> Agent {
        self.agents.get(agent_id).cloned().unwrap_or_else(|| fail("UNKNOWN_AGENT", agent_id))
    }

    fn derive(&self, agent_id: &str) -> Pubkey {
        derive::derived_key(
            &self.mpc_root,
            env::current_account_id().as_str(),
            &derive::agent_path(agent_id),
        )
    }

    fn recipients(policy: &Policy) -> Vec<Pubkey> {
        require!(
            policy.allowed_recipients.len() <= 32 && policy.allowed_domains.len() <= 32,
            "INVALID_ARGUMENT: at most 32 recipients and 32 domains"
        );
        require!(
            policy.max_per_request.0 <= policy.daily_limit.0,
            "INVALID_ARGUMENT: max_per_request can't exceed daily_limit"
        );
        policy.allowed_recipients.iter().map(|r| key(r, "recipient")).collect()
    }

    fn auth_message(&self, action: &str, agent_id: &str, nonce: u64, payload: &[u8]) -> Vec<u8> {
        format!(
            "vexa-policy/v1\n{}\n{action}\n{agent_id}\n{nonce}\n{}",
            env::current_account_id(),
            hex::encode(env::sha256_array(payload))
        )
        .into_bytes()
    }

    fn verify(
        &self,
        key: &Pubkey,
        action: &str,
        agent_id: &str,
        nonce: u64,
        payload: &[u8],
        signature: &[u8],
    ) {
        let signature: [u8; 64] = signature
            .try_into()
            .unwrap_or_else(|_| fail("BAD_SIGNATURE", "signatures are 64 bytes"));
        let message = self.auth_message(action, agent_id, nonce, payload);
        require!(
            env::ed25519_verify(&signature, &message, key),
            "BAD_SIGNATURE: authorization signature is invalid"
        );
    }

    fn verify_owner(
        &self,
        agent: &Agent,
        action: &str,
        agent_id: &str,
        nonce: u64,
        payload: &[u8],
        signature: &[u8],
    ) {
        require!(nonce == agent.auth_nonce, "STALE_NONCE: use the agent's current auth_nonce");
        self.verify(&agent.owner, action, agent_id, nonce, payload, signature);
    }

    fn charge_storage(&self, start: u64) {
        let used = env::storage_usage().saturating_sub(start);
        let cost = env::storage_byte_cost().saturating_mul(used as u128);
        let attached = env::attached_deposit();
        require!(attached >= cost, format!("INSUFFICIENT_DEPOSIT: storage costs {cost}"));
        let refund = attached.saturating_sub(cost);
        if !refund.is_zero() {
            Promise::new(env::predecessor_account_id()).transfer(refund).detach();
        }
    }

    /// Classifies an agent transaction and checks it against the policy.
    /// Anything that isn't exactly one of the known shapes is refused.
    fn check(
        &self,
        agent: &Agent,
        ixs: &[Instruction],
        signers: &[Pubkey],
        proofs: PaymentProofs,
    ) -> Action {
        if signers != [self.fee_payer, agent.address] {
            fail("BAD_TRANSACTION", "signers must be Vexa's fee payer, then the agent");
        }
        // Apply pending: make received funds spendable. Moves nothing out.
        if let [ix] = ixs {
            if ix.program == solana::TOKEN_2022_PROGRAM
                && ix.data.first() == Some(&TOKEN_CONFIDENTIAL)
                && ix.data.get(1) == Some(&CT_APPLY_PENDING)
                && ix.accounts == [agent.cusdc, agent.address]
            {
                return Action::Maintenance;
            }
        }
        if self.is_configure(agent, ixs) {
            return Action::Maintenance;
        }
        self.check_payment(agent, ixs, proofs)
    }

    /// Opening the agent's confidential account, as `configurePlan` builds
    /// it: an optional rent transfer from the fee payer to the agent, the
    /// pubkey validity proof, and the vault's configure.
    fn is_configure(&self, agent: &Agent, ixs: &[Instruction]) -> bool {
        let rest = match ixs {
            [transfer, rest @ ..]
                if transfer.program == solana::SYSTEM_PROGRAM
                    && transfer.data.starts_with(&SYSTEM_TRANSFER)
                    && transfer.accounts == [self.fee_payer, agent.address] =>
            {
                rest
            }
            other => other,
        };
        matches!(rest, [proof, configure]
            if proof.program == solana::ZK_ELGAMAL_PROOF_PROGRAM
                && proof.data.first() == Some(&ZK_VERIFY_PUBKEY_VALIDITY)
                && proof.accounts.is_empty()
                && configure.program == self.vault_program
                && configure.data.first() == Some(&VAULT_CONFIGURE)
                && configure.accounts.first() == Some(&agent.address)
                && configure.accounts.get(3) == Some(&agent.cusdc))
    }

    /// A confidential transfer out of the agent's account:
    ///
    /// ```text
    ///   AdvanceNonce(agent nonce account, authority agent)
    ///   [vault RequireContexts(validity, limit)]     not for sweeps to the owner
    ///   Token-2022 ConfidentialTransfer(agent cUSDC → recipient, context accounts)
    ///   ZK CloseContextState × up to 4               (the fee payer's contexts)
    /// ```
    fn check_payment(&self, agent: &Agent, ixs: &[Instruction], proofs: PaymentProofs) -> Action {
        let mut it = ixs.iter();
        let nonce = it.next().unwrap_or_else(|| fail("BAD_TRANSACTION", "empty transaction"));
        if nonce.program != solana::SYSTEM_PROGRAM
            || nonce.data != SYSTEM_ADVANCE_NONCE
            || nonce.accounts
                != [agent.nonce_account, solana::RECENT_BLOCKHASHES_SYSVAR, agent.address]
        {
            fail("BAD_TRANSACTION", "a payment must start by advancing the agent's durable nonce");
        }
        let mut next = it.next().unwrap_or_else(|| fail("BAD_TRANSACTION", "no transfer"));
        let require_contexts = if next.program == self.vault_program {
            let r = next;
            next = it.next().unwrap_or_else(|| fail("BAD_TRANSACTION", "no transfer"));
            Some(r)
        } else {
            None
        };

        let transfer = next;
        // Data: tag, sub-tag, new decryptable balance (36), auditor ciphertexts
        // lo and hi (64 each), then the three proof offsets, all zero because
        // the proofs are in context accounts.
        if transfer.program != solana::TOKEN_2022_PROGRAM
            || transfer.data.len() != CT_TRANSFER_DATA_LEN
            || transfer.data[0] != TOKEN_CONFIDENTIAL
            || transfer.data[1] != CT_TRANSFER
            || transfer.data[CT_TRANSFER_DATA_LEN - 3..] != [0, 0, 0]
            || transfer.accounts.len() != 7
        {
            fail(
                "BAD_TRANSACTION",
                "expected a confidential transfer using proof context accounts",
            );
        }
        let (source, mint, destination, validity_account, authority) = (
            transfer.accounts[0],
            transfer.accounts[1],
            transfer.accounts[2],
            transfer.accounts[4],
            transfer.accounts[6],
        );
        if source != agent.cusdc || authority != agent.address || mint != self.cusdc_mint {
            fail("BAD_TRANSACTION", "the transfer must be from the agent's own cUSDC account");
        }
        for close in it {
            if close.program != solana::ZK_ELGAMAL_PROOF_PROGRAM
                || close.data != [ZK_CLOSE_CONTEXT]
                || close.accounts.len() != 3
                || close.accounts[2] == agent.address
            {
                fail(
                    "BAD_TRANSACTION",
                    "only closing the fee payer's proof contexts may follow the transfer",
                );
            }
        }

        // Sending everything back to the owner is always allowed, even for a
        // paused or revoked agent, and doesn't count against the limits.
        if destination == agent.owner_cusdc {
            if require_contexts.is_some() {
                fail("BAD_TRANSACTION", "a sweep to the owner carries no limit proof");
            }
            return Action::Maintenance;
        }

        match agent.status {
            Status::Active => {}
            Status::Paused => fail("AGENT_PAUSED", "the owner has paused this agent"),
            Status::Revoked => fail("AGENT_REVOKED", "the agent is revoked"),
        }
        if !agent.recipients.is_empty() && !agent.recipients.contains(&destination) {
            fail("RECIPIENT_NOT_ALLOWED", solana::encode(&destination));
        }
        if !agent.policy.allowed_domains.is_empty() {
            let domain =
                proofs.domain.unwrap_or_else(|| fail("DOMAIN_NOT_ALLOWED", "no domain given"));
            if !agent.policy.allowed_domains.iter().any(|d| d == domain) {
                fail("DOMAIN_NOT_ALLOWED", domain);
            }
        }

        // The limit proof, bound to this transaction by RequireContexts.
        let (validity, limit) = match (proofs.validity, proofs.limit) {
            (Some(v), Some(l)) => (v, l),
            _ => fail(
                "LIMIT_PROOF_MISSING",
                "payments carry their validity and limit proof contexts",
            ),
        };
        let require_contexts = require_contexts
            .unwrap_or_else(|| fail("LIMIT_PROOF_MISSING", "no RequireContexts instruction"));
        let mut expected = vec![VAULT_REQUIRE_CONTEXTS];
        expected.extend_from_slice(&env::sha256_array(validity));
        expected.extend_from_slice(&env::sha256_array(limit));
        if require_contexts.data != expected
            || require_contexts.accounts.len() != 2
            || require_contexts.accounts[0] != validity_account
        {
            fail(
                "LIMIT_PROOF_MISMATCH",
                "RequireContexts must name the transfer's validity context and the limit proof",
            );
        }

        let index =
            proofs.index.unwrap_or_else(|| fail("INVALID_ARGUMENT", "payments need an index"));
        if index != agent.next_index {
            fail("STALE_INDEX", format!("the next payment index is {}", agent.next_index));
        }
        let window_start = proofs.window_start.unwrap_or(index);
        let now = env::block_timestamp_ms();
        let mut spent = Vec::new();
        for s in &agent.window {
            let expired = s.at_ms + DAY_MS <= now;
            if s.index >= window_start {
                spent.push(zk::point(&s.commitment).unwrap_or_else(|e| fail("CORRUPT_WINDOW", e)));
            } else if !expired {
                fail(
                    "LIMIT_PROOF_MISMATCH",
                    format!("payment {} is still within 24 hours", s.index),
                );
            }
        }

        let amount = zk::transfer_amount_commitment(validity)
            .unwrap_or_else(|e| fail("LIMIT_PROOF_MISMATCH", e));
        let (per_request, daily) =
            zk::limit_commitments(limit).unwrap_or_else(|e| fail("LIMIT_PROOF_MISMATCH", e));
        if per_request != zk::remaining(agent.policy.max_per_request.0, &[amount]) {
            fail("LIMIT_PROOF_MISMATCH", "the per-payment limit proof doesn't cover this payment");
        }
        spent.push(amount);
        if daily != zk::remaining(agent.policy.daily_limit.0, &spent) {
            fail("LIMIT_PROOF_MISMATCH", "the daily limit proof doesn't cover the last 24 hours");
        }
        Action::Payment { index, commitment: amount.compress().to_bytes() }
    }
}
