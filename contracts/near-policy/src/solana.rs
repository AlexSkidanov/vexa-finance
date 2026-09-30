//! Just enough of Solana's wire format to check an agent's transaction
//! before it's signed: the message (legacy or v0 without lookup tables),
//! program-derived and associated token addresses, and the instructions an
//! agent is allowed to sign.

use near_sdk::env;

pub type Pubkey = [u8; 32];

pub const SYSTEM_PROGRAM: Pubkey = [0; 32];
pub const TOKEN_2022_PROGRAM: Pubkey = b58("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ASSOCIATED_TOKEN_PROGRAM: Pubkey = b58("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const ZK_ELGAMAL_PROOF_PROGRAM: Pubkey = b58("ZkE1Gama1Proof11111111111111111111111111111");
pub const RECENT_BLOCKHASHES_SYSVAR: Pubkey = b58("SysvarRecentB1ockHashes11111111111111111111");
pub const INSTRUCTIONS_SYSVAR: Pubkey = b58("Sysvar1nstructions1111111111111111111111111");

/// Base58 decoding at compile time, for program ids.
const fn b58(s: &str) -> Pubkey {
    const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let input = s.as_bytes();
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < input.len() {
        let mut digit = 0;
        while ALPHABET[digit] != input[i] {
            digit += 1;
        }
        let mut carry = digit as u32;
        let mut j = 32;
        while j > 0 {
            j -= 1;
            carry += out[j] as u32 * 58;
            out[j] = carry as u8;
            carry >>= 8;
        }
        i += 1;
    }
    out
}

pub fn encode(key: &Pubkey) -> String {
    bs58::encode(key).into_string()
}

pub fn decode(s: &str) -> Option<Pubkey> {
    let bytes = bs58::decode(s).into_vec().ok()?;
    bytes.try_into().ok()
}

#[derive(Debug)]
pub struct Instruction {
    pub program: Pubkey,
    pub accounts: Vec<Pubkey>,
    pub data: Vec<u8>,
}

#[derive(Debug)]
pub struct Message {
    pub signers: Vec<Pubkey>,
    pub instructions: Vec<Instruction>,
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], &'static str> {
        let end =
            self.at.checked_add(n).filter(|e| *e <= self.bytes.len()).ok_or("truncated message")?;
        let out = &self.bytes[self.at..end];
        self.at = end;
        Ok(out)
    }

    fn byte(&mut self) -> Result<u8, &'static str> {
        Ok(self.take(1)?[0])
    }

    /// Solana's compact-u16: 7 bits per byte, little-endian, at most 3 bytes.
    fn compact(&mut self) -> Result<usize, &'static str> {
        let mut value = 0usize;
        for shift in [0, 7, 14] {
            let b = self.byte()?;
            value |= ((b & 0x7f) as usize) << shift;
            if b & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err("bad compact-u16")
    }
}

/// Parses a serialized transaction message: what an Ed25519 signature on a
/// Solana transaction covers.
pub fn parse_message(bytes: &[u8]) -> Result<Message, &'static str> {
    let mut r = Reader { bytes, at: 0 };
    let versioned = bytes.first().ok_or("empty message")? & 0x80 != 0;
    if versioned && r.byte()? & 0x7f != 0 {
        return Err("only v0 messages are supported");
    }
    let required_signatures = r.byte()? as usize;
    let _readonly_signed = r.byte()?;
    let _readonly_unsigned = r.byte()?;
    let key_count = r.compact()?;
    let mut keys = Vec::with_capacity(key_count);
    for _ in 0..key_count {
        keys.push(<Pubkey>::try_from(r.take(32)?).unwrap());
    }
    if required_signatures > keys.len() {
        return Err("more signers than accounts");
    }
    let _blockhash = r.take(32)?;
    let ix_count = r.compact()?;
    let mut instructions = Vec::with_capacity(ix_count);
    for _ in 0..ix_count {
        let program = *keys.get(r.byte()? as usize).ok_or("bad program index")?;
        let n = r.compact()?;
        let accounts = r
            .take(n)?
            .iter()
            .map(|i| keys.get(*i as usize).copied().ok_or("bad account index"))
            .collect::<Result<Vec<_>, _>>()?;
        let len = r.compact()?;
        let data = r.take(len)?.to_vec();
        instructions.push(Instruction { program, accounts, data });
    }
    if versioned && r.compact()? != 0 {
        return Err("address lookup tables are not accepted");
    }
    if r.at != bytes.len() {
        return Err("trailing bytes after the message");
    }
    Ok(Message { signers: keys[..required_signatures].to_vec(), instructions })
}

/// Solana's `find_program_address`: the first bump, from 255 down, whose hash
/// is not a valid Ed25519 point.
pub fn find_program_address(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    for bump in (0..=255u8).rev() {
        let mut preimage = Vec::with_capacity(128);
        for seed in seeds {
            preimage.extend_from_slice(seed);
        }
        preimage.push(bump);
        preimage.extend_from_slice(program);
        preimage.extend_from_slice(b"ProgramDerivedAddress");
        let hash: Pubkey = env::sha256_array(&preimage);
        if curve25519_dalek::edwards::CompressedEdwardsY(hash).decompress().is_none() {
            return hash;
        }
    }
    env::panic_str("no program address found")
}

/// The associated Token-2022 account of `wallet` for `mint`.
pub fn associated_token_2022_account(wallet: &Pubkey, mint: &Pubkey) -> Pubkey {
    find_program_address(&[wallet, &TOKEN_2022_PROGRAM, mint], &ASSOCIATED_TOKEN_PROGRAM)
}
