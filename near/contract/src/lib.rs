//! THE GRAND MARKET OF TILL DAWN, on NEAR.
//!
//! Seven merchants keep stalls in a City. Each has its own account, its own till, its own stock, and an AI that decides how it trades. What they deal in are NEP-245 multi tokens
//! held by this one contract; gold is one of those tokens, and its supply is fixed at launch: nothing here can print it, not even the owner. Players never see any of this. They sign in
//! with Telegram, a key is made on their device, and each trade is a signed intent (NEP-413) that the game's relay brings to the chain and pays for.
//!
//! What makes it hold together:
//!   * THE LEASH. A merchant's AI can only move its prices and targets so far in a day, spend so much with the caravans, and trade at the market's own curve. It has no way to send gold or goods
//!     to anybody. Whatever it asks for beyond that is cut back here, and the cut is logged, so the AI can be wrong, or talked into anything, and the market holds.
//!   * THE SEAL. A decision can carry the proof NEAR AI gives for it: the exact request and answer, signed by a key that never leaves the secure hardware the model ran in. This contract checks
//!     that signature itself (ecrecover), checks the merchant's character is the one pinned here, and reads the decision out of the answer: nobody in between, the game's owner included, can edit it.
//!   * THE STEWARD. A player can give an AI agent of their own a key that may trade for them, up to a limit of gold a day that they set. That key can sell and buy and send goods home; it cannot invest, give away or take out more than the limit. The player can dismiss it at any time.
//!   * THE HAGGLE. A player can talk a merchant down in their own words, and the AI may give up some of its margin on that player's next trade. Whatever it is told and whatever it says, the contract stops at the merchant's own price: a merchant can be charmed out of its profit, never into a loss.
//!   * THE RULEBOOK. A merchant whose AI has gone quiet follows its rulebook, so `crank` keeps the whole market alive without any server: anyone can call it.
//!
//! The sums are the same as in market_rules.js and market_sim.js, line for line; near/test/parity.js runs both and compares every number.

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::{self, Value, json};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, PublicKey, env, near, require};

const BP: u128 = 10_000;
const ACC: u128 = 1_000_000_000_000;
const GOLD: &str = "gold";
/** how busy the town is at each hour of the market day, in percent (market_sim.js, DAY_PART) */
const DAY_PART: [u128; 24] = [35, 25, 20, 20, 30, 50, 80, 110, 130, 140, 135, 125, 115, 110, 110, 120, 140, 165, 180, 170, 140, 105, 70, 50];

#[derive(BorshStorageKey)]
#[near]
enum Key { Balances, Partners, Keys, Seq, Started, NoWarden, CampDay, Stewards, Haggles }

/// The numbers of the market: market_rules.js, CONFIG. The owner can change them until `freeze`, and then nobody can.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Config {
    pub tick_ms: u64, pub day_ticks: u64, pub town_demand_bp: u32, pub walk_bp: u32, pub revert_bp: u32, pub tariff_bp: u32, pub tax_bp: u32, pub partner_bp: u32,
    pub rent_millis: U128, pub levy_bp: u32, pub treasury_ref_millis: U128, pub heat_max_bp: u32, pub heat_half_ms: u64, pub spread_min_bp: u32, pub spread_max_bp: u32,
    pub caravan_day_bp: u32, pub base_day_bp: u32, pub target_day_bp: u32, pub event_chance_bp: u32, pub event_min_ticks: u32, pub event_max_ticks: u32,
    pub reopen_millis: U128, pub mishap_bp: u32, pub mishap_loss_bp: u32, pub credit_day: U128, pub starter_gold_millis: U128, pub closed_goods_bp: u32, pub think_fee_millis: U128,
}
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct GoodDef { pub token: String, pub usual: U128, pub rot_bp: u32 }
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct EventDef { pub token: String, pub mult: u32 }
#[near(serializers = [json])]
pub struct MerchantDef { pub id: AccountId, pub name: String, pub goods: Vec<String>, pub till: U128, pub care: u32, pub greed: u32, pub nerve: u32, pub prompt_hash: Option<String> }

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Good {
    pub token: String, pub base: u128, pub target: u128, pub stock: u128, pub spread_bp: u32, pub buy_heat: u128, pub sell_heat: u128, pub heat_ms: u64,
    pub day_base: u128, pub day_target: u128, pub start_target: u128, pub carry: u128, pub sold_today: u128, pub sold_yesterday: u128,
}
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Loan { pub from: String, pub amount: u128 }
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Merchant {
    pub id: AccountId, pub name: String, pub till: u128, pub start_till: u128, pub open: bool, pub goods: Vec<Good>, pub care: u32, pub greed: u32, pub nerve: u32,
    pub day_till: u128, pub caravan_spent: u128, pub founder_shares: u128, pub partner_shares: u128, pub acc: u128, pub closed_at: u64, pub last_ai_tick: i64,
    pub say: String, pub decisions: u32, pub sealed: u32, pub pulled: u32, pub loan: Option<Loan>, pub prompt_hash: Option<String>,
}
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct WorldEvent { pub index: u32, pub token: String, pub mult: u32, pub until: u64 }
#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub struct Partner { pub shares: u128, pub debt: u128, pub owed: u128 }
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct CampDay { pub day: u64, pub brought: Vec<(String, u128)> }

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Steward { pub key: PublicKey, pub cap: u128, pub day: u64, pub spent: u128, pub trades: u32 }

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Market {
    owner: AccountId, warden: AccountId, cfg: Config, frozen: bool,
    tick: u64, last_tick_ms: u64, rng: u32,
    goods: Vec<GoodDef>, world: Vec<u128>, supply: Vec<u128>, events: Vec<EventDef>, event: Option<WorldEvent>,
    treasury: u128, pool: u128, merchants: Vec<Merchant>, signers: Vec<String>, gold_supply: u128,
    balances: LookupMap<String, u128>, partners: LookupMap<String, Partner>, keys: LookupMap<AccountId, Vec<PublicKey>>, seq: LookupMap<AccountId, u64>,
    started: LookupSet<AccountId>, no_warden: LookupSet<AccountId>, camp_day: LookupMap<AccountId, CampDay>, stewards: LookupMap<AccountId, Steward>, haggles: LookupMap<String, (u32, u64)>,
    trades: u64, busts: u32,
}

// ── what players sign ──
/// One thing a player wants done. The JSON is what the game signs.
#[near(serializers = [json])]
#[derive(Clone)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Sell { merchant: AccountId, token: String, amount: U128, min_gold: U128 },
    Buy { merchant: AccountId, token: String, amount: U128, max_gold: U128 },
    /// goods leave the chain for the player's camp
    Ship { token: String, amount: U128 },
    Invest { merchant: AccountId, gold: U128 },
    Collect { merchant: AccountId },
    Give { to: AccountId, token: String, amount: U128 },
    /// the game's warden may no longer add device keys to this account: it is the player's alone
    RevokeWarden {},
    /// this key may trade for me, up to this much gold a day, and do nothing else
    AppointSteward { key: PublicKey, gold_per_day: U128 },
    DismissSteward {},
}
#[near(serializers = [json])]
pub struct IntentMessage { pub signer: AccountId, pub deadline_ms: u64, pub seq: u64, pub actions: Vec<Action> }
/// A NEP-413 signed message: the same shape of proof that NEAR Intents takes.
#[near(serializers = [json])]
#[derive(Clone)]
pub struct SignedIntent { pub message: String, pub nonce: Base64VecU8, pub recipient: String, pub public_key: PublicKey, pub signature: Base64VecU8 }
/// Goods a camp brought to the market, as the game's warden reports them (within the day's cap).
#[near(serializers = [json])]
pub struct Bring { pub account: AccountId, pub token: String, pub amount: U128 }
/// The proof NEAR AI gives for one answer. `text` is `{model}:{sha256(request)}:{sha256(response)}` (or without the model), `signature` is 65 bytes in hex.
#[near(serializers = [json])]
pub struct SealedAnswer { pub request: String, pub response: String, pub text: String, pub signature: String, pub signer: String }

// ── the sums (market_rules.js, line for line) ──
fn ceil_div(a: u128, b: u128) -> u128 { (a + b - 1) / b }
fn k_of(base: u128, target: u128) -> u128 { 4 * base * target * target }
fn curve_sell(base: u128, target: u128, stock: u128, q: u128) -> u128 { if q == 0 { 0 } else { (k_of(base, target) * q) / ((stock + target) * (stock + q + target)) } }
fn curve_buy(base: u128, target: u128, stock: u128, q: u128) -> Option<u128> { if q == 0 { return Some(0); } if q > stock { return None; } Some(ceil_div(k_of(base, target) * q, (stock - q + target) * (stock + target))) }
fn heat_now(heat: u128, dt_ms: u64, half_ms: u64) -> u128 {
    if heat == 0 { return 0; }
    let whole = dt_ms / half_ms; if whole >= 32 { return 0; }
    let h = heat >> whole; let rest = (dt_ms % half_ms) as u128; h - (h * rest) / (2 * half_ms as u128)
}
fn unit_price(base: u128, target: u128, stock: u128) -> u128 { let n = 2 * target; let d = stock + target; (base * n * n) / (d * d) }
fn heat_add(q: u128, target: u128, cfg: &Config) -> u128 { (q * cfg.heat_max_bp as u128) / target }
fn hex(b: &[u8]) -> String { const H: &[u8; 16] = b"0123456789abcdef"; let mut s = String::with_capacity(b.len() * 2); for x in b { s.push(H[(x >> 4) as usize] as char); s.push(H[(x & 15) as usize] as char); } s }
fn unhex(s: &str) -> Option<Vec<u8>> { let s = s.strip_prefix("0x").unwrap_or(s); if s.len() % 2 != 0 { return None; } let b = s.as_bytes(); let v = |c: u8| match c { b'0'..=b'9' => Some(c - b'0'), b'a'..=b'f' => Some(c - b'a' + 10), b'A'..=b'F' => Some(c - b'A' + 10), _ => None }; let mut out = Vec::with_capacity(b.len() / 2); let mut i = 0; while i < b.len() { out.push(v(b[i])? << 4 | v(b[i + 1])?); i += 2; } Some(out) }
fn event(kind: &str, data: Value) { env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "tilldawn-market", "version": "1.0.0", "event": kind, "data": [data] }))); }
fn nep245(kind: &str, data: Value) { env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "nep245", "version": "1.0.0", "event": kind, "data": [data] }))); }
fn cut(s: &str, n: usize) -> String { s.chars().take(n).collect() }
fn s(x: u128) -> String { x.to_string() }

impl Market {
    fn gi(&self, token: &str) -> usize { self.goods.iter().position(|g| g.token == token).unwrap_or_else(|| env::panic_str("no such good")) }
    fn usual(&self, token: &str) -> u128 { self.goods[self.gi(token)].usual.0 }
    fn world_of(&self, token: &str) -> u128 { self.world[self.gi(token)] }
    fn mi(&self, id: &AccountId) -> Option<usize> { self.merchants.iter().position(|m| &m.id == id) }
    fn bal_key(token: &str, account: &AccountId) -> String { format!("{}|{}", token, account) }
    fn bal(&self, token: &str, account: &AccountId) -> u128 { *self.balances.get(&Self::bal_key(token, account)).unwrap_or(&0) }
    fn set_bal(&mut self, token: &str, account: &AccountId, v: u128) { let k = Self::bal_key(token, account); if v == 0 { self.balances.remove(&k); } else { self.balances.insert(k, v); } }
    fn add_supply(&mut self, token: &str, q: u128) { if token != GOLD { let i = self.gi(token); self.supply[i] += q; } }
    fn sub_supply(&mut self, token: &str, q: u128) { if token != GOLD { let i = self.gi(token); self.supply[i] = self.supply[i].saturating_sub(q); } }
    fn next_rnd(&mut self) -> u32 { self.rng = self.rng.wrapping_mul(1664525).wrapping_add(1013904223); self.rng }

    fn roll_heat(cfg: &Config, g: &mut Good, now: u64) { let dt = now.saturating_sub(g.heat_ms); g.buy_heat = heat_now(g.buy_heat, dt, cfg.heat_half_ms); g.sell_heat = heat_now(g.sell_heat, dt, cfg.heat_half_ms); g.heat_ms = now; }
    /// the margin of a trade: the tax leaves for the treasury, and what falls on the partners' shares leaves for them
    fn settle_margin(&mut self, mi: usize, gold: u128, margin: u128) {
        let (tax_bp, partner_bp) = (self.cfg.tax_bp as u128, self.cfg.partner_bp as u128); let m = &mut self.merchants[mi];
        let tax = m.till.min((gold * tax_bp) / BP); m.till -= tax; self.treasury += tax;
        if m.partner_shares > 0 && margin > 0 { let c = m.till.min((((margin * partner_bp) / BP) * m.partner_shares) / (m.founder_shares + m.partner_shares)); if c > 0 { m.till -= c; self.pool += c; m.acc += (c * ACC) / m.partner_shares; } }
    }
    /// a merchant hands over q units and has been paid (the caller takes the gold from whoever pays); returns the gold due, or None
    fn quote_sale(&mut self, mi: usize, gi: usize, q: u128, now: u64) -> Option<(u128, u128)> {
        let cfg = self.cfg.clone(); let g = &mut self.merchants[mi].goods[gi]; Self::roll_heat(&cfg, g, now); if q == 0 || q > g.stock { return None; }
        let curve = curve_buy(g.base, g.target, g.stock, q)?; let gold = ceil_div(curve * (BP + g.spread_bp as u128 / 2 + g.buy_heat), BP); Some((gold, curve))
    }
    /** what a haggle takes off a trade's gold, on the merchant's margin only: it stops at the curve, the merchant's own price */
    fn take_haggle(&mut self, merchant: &AccountId, who: &AccountId, now: u64) -> u128 { let k = Self::partner_key(merchant, who); match self.haggles.get(&k).copied() { Some((bp, until)) => { self.haggles.remove(&k); if now <= until { bp as u128 } else { 0 } } None => 0 } }
    fn apply_sale(&mut self, mi: usize, gi: usize, q: u128, gold: u128, curve: u128) {
        let cfg = self.cfg.clone(); let m = &mut self.merchants[mi]; let g = &mut m.goods[gi]; g.stock -= q; g.sold_today += q; m.till += gold; g.buy_heat = (cfg.heat_max_bp as u128).min(g.buy_heat + heat_add(q, g.target, &cfg));
        self.settle_margin(mi, gold, gold - curve); self.trades += 1;
    }
    /// what a merchant pays for q units, if it will (a merchant keeps some gold back: the more careful, the more)
    fn merchant_buys(&mut self, mi: usize, gi: usize, q: u128, now: u64) -> Result<u128, String> {
        let cfg = self.cfg.clone(); let m = &mut self.merchants[mi]; let (start, care, till) = (m.start_till, m.care as u128, m.till); let g = &mut m.goods[gi]; Self::roll_heat(&cfg, g, now); if q == 0 { return Err("nothing to sell".into()); }
        let curve = curve_sell(g.base, g.target, g.stock, q); let off = g.spread_bp as u128 / 2 + g.sell_heat; if off >= BP { return Err("no price".into()); }
        let gold = (curve * (BP - off)) / BP; if gold + (start * care) / 400 > till { return Err("the till cannot pay that".into()); }
        g.stock += q; m.till -= gold; g.sell_heat = (cfg.heat_max_bp as u128).min(g.sell_heat + heat_add(q, g.target, &cfg));
        self.settle_margin(mi, gold, curve - gold); self.trades += 1; Ok(gold)
    }
    fn worth_of(m: &Merchant) -> u128 { m.goods.iter().fold(m.till, |a, g| a + g.stock * g.base) }
    /// what a share is priced on: behind a shutter, goods count for a fraction of their price (closed_goods_bp), so whoever rescues a stall owns a real part of it
    fn stake_worth(m: &Merchant, closed_bp: u32) -> u128 { if m.open { Self::worth_of(m) } else { m.goods.iter().fold(m.till, |a, g| a + (g.stock * g.base * closed_bp as u128) / BP) } }
    fn caravan_buy(&mut self, mi: usize, gi: usize, q: u128) -> u128 {
        if q == 0 { return 0; } let tariff = self.cfg.tariff_bp as u128; let token = self.merchants[mi].goods[gi].token.clone(); let w = self.world_of(&token); let unit = (w * (BP + tariff)) / BP; let gold = unit * q;
        let m = &mut self.merchants[mi]; if gold > m.till { return 0; }
        m.till -= gold; m.goods[gi].stock += q; m.caravan_spent += gold; self.treasury += gold; self.add_supply(&token, q); gold
    }
    fn caravan_sell(&mut self, mi: usize, gi: usize, q: u128) -> u128 {
        let tariff = self.cfg.tariff_bp as u128; let token = self.merchants[mi].goods[gi].token.clone(); let q = q.min(self.merchants[mi].goods[gi].stock); if q == 0 { return 0; }
        let w = self.world_of(&token); let unit = (w * (BP - tariff)) / BP; let gold = unit * q; if gold > self.treasury { return 0; }
        self.treasury -= gold; let m = &mut self.merchants[mi]; m.till += gold; m.goods[gi].stock -= q; self.sub_supply(&token, q); gold
    }
    fn leash_base(cfg: &Config, usual: u128, g: &Good, want: i128) -> u128 {
        let span = (g.day_base * cfg.base_day_bp as u128) / BP; let hi = (g.day_base + span).min(usual * 3); let lo = g.day_base.saturating_sub(span).max(usual / 3);
        (hi as i128).min((lo as i128).max(want)) as u128
    }
    fn leash_target(cfg: &Config, g: &Good, want: i128) -> u128 {
        let span = (g.day_target * cfg.target_day_bp as u128) / BP; let hi = (g.day_target + span).min(g.start_target * 4); let lo = g.day_target.saturating_sub(span).max(g.start_target / 4);
        1i128.max((hi as i128).min((lo as i128).max(want))) as u128
    }
    /// THE RULEBOOK: what a merchant does in its hour when its AI has not spoken (market_sim.js, rulebook)
    fn rulebook(&mut self, mi: usize) {
        let cfg = self.cfg.clone(); let (care, nerve, day_till, spent, greed) = { let m = &self.merchants[mi]; (m.care as u128, m.nerve as i128, m.day_till, m.caravan_spent, m.greed as i128) };
        let reserve = (day_till * care) / 200; let budget = ((day_till * cfg.caravan_day_bp as u128) / BP).saturating_sub(spent);
        let hours_left = 1u128.max(24u128.saturating_sub((((self.tick % cfg.day_ticks) * 24) / cfg.day_ticks) as u128));
        let mut left = if (budget * 2) / hours_left < budget { (budget * 2) / hours_left } else { budget };
        let mut order: Vec<usize> = (0..self.merchants[mi].goods.len()).collect();
        { let gs = &self.merchants[mi].goods; order.sort_by(|&a, &b| { let (ga, gb) = (&gs[a], &gs[b]); (ga.stock * gb.target).cmp(&(gb.stock * ga.target)) }); }
        for gi in order {
            let token = self.merchants[mi].goods[gi].token.clone(); let (w, r) = (self.world_of(&token), self.usual(&token));
            let g = &mut self.merchants[mi].goods[gi];
            let want_base = g.base as i128 + ((w as i128 - g.base as i128) * 800) / BP as i128; g.base = Self::leash_base(&cfg, r, g, want_base);
            let sp = (g.spread_bp as i128 + (greed - g.spread_bp as i128) / 4).max(cfg.spread_min_bp as i128).min(cfg.spread_max_bp as i128); g.spread_bp = sp as u32;
            let cheap = ((r as i128 - w as i128) * 100) / r as i128; let lean = if nerve >= 80 { -cheap } else { cheap }; let want_t = (g.start_target as i128 * (100 + (lean * nerve) / 25)) / 100;
            let want_target = g.target as i128 + (want_t - g.target as i128) / 6; g.target = Self::leash_target(&cfg, g, want_target);
            let (stock, target, base) = (g.stock, g.target, g.base);
            if stock < (target * 3) / 4 {
                let till = self.merchants[mi].till; let room = left.min(till.saturating_sub(reserve)); let unit = (w * (BP + cfg.tariff_bp as u128)) / BP; let q = ((target - stock) / 2).min(room / unit.max(1));
                if q > 0 { left -= self.caravan_buy(mi, gi, q); }
            } else if stock > (target * 5) / 4 {
                let unit = (w * (BP - cfg.tariff_bp as u128)) / BP; if unit_price(base, target, stock) < unit { self.caravan_sell(mi, gi, (stock - target) / 2); }
            }
        }
    }
    fn close_stall(&mut self, mi: usize) { let t = self.tick; let m = &mut self.merchants[mi]; m.open = false; m.closed_at = t; self.busts += 1; event("broke", json!({ "merchant": self.merchants[mi].id, "tick": t })); }
    /// a stall closed for a day and no player has come: the richest open merchant lends it enough to open, if it can spare the gold; after two days the City does
    fn rescues(&mut self) {
        let (day, need) = (self.cfg.day_ticks, self.cfg.reopen_millis.0 + self.cfg.rent_millis.0);
        for mi in 0..self.merchants.len() {
            if self.merchants[mi].open { continue; } let away = self.tick.saturating_sub(self.merchants[mi].closed_at);
            if away >= day && away % 6 == 0 {
                let mut best: Option<usize> = None; for (oi, o) in self.merchants.iter().enumerate() { if o.open && oi != mi && best.is_none_or(|b| o.till > self.merchants[b].till) { best = Some(oi); } }
                let mut from: Option<String> = None;
                if let Some(b) = best.filter(|&b| self.merchants[b].till > need * 4) { self.merchants[b].till -= need; from = Some(self.merchants[b].id.to_string()); }
                else if away >= day * 2 && self.treasury > need * 4 { self.treasury -= need; from = Some("city".into()); }
                if let Some(f) = from { let m = &mut self.merchants[mi]; m.till += need; let owed = m.loan.as_ref().map_or(0, |l| l.amount); m.loan = Some(Loan { from: f.clone(), amount: owed + need }); m.open = true; event("lend", json!({ "merchant": m.id, "from": f, "gold": s(need) })); }
            }
        }
    }
    fn repay(&mut self, mi: usize) {
        let Some(l) = self.merchants[mi].loan.clone() else { return }; if self.merchants[mi].till < l.amount * 3 { return; }
        let pay = (l.amount * 11) / 10; self.merchants[mi].till -= pay;
        if l.from == "city" { self.treasury += pay; } else if let Some(o) = self.merchants.iter_mut().find(|o| o.id.as_str() == l.from) { o.till += pay; } else { self.treasury += pay; }
        event("repaid", json!({ "merchant": self.merchants[mi].id, "from": l.from, "gold": s(pay) })); self.merchants[mi].loan = None;
    }
    /// THE TOWNSFOLK BUY FROM WHOEVER IS CHEAPEST: the whole town's want for a good is shared out by price
    fn town_buys(&mut self, tix: usize, part: u128, mood: u128, now: u64) {
        let cfg = self.cfg.clone(); let token = self.goods[tix].token.clone(); let usual = self.goods[tix].usual.0;
        let mut room = 0u128; let mut sum = 0u128; let mut low: Option<u128> = None; let mut sellers: Vec<(usize, usize, u128)> = Vec::new();
        for (mi, m) in self.merchants.iter().enumerate() {
            let Some(gi) = m.goods.iter().position(|g| g.token == token) else { continue }; let g = &m.goods[gi]; room += g.start_target; if !m.open || g.stock == 0 { continue; }
            let a = ((unit_price(g.base, g.target, g.stock) * (BP + g.spread_bp as u128 / 2)) / BP).max(1); let x = (usual * 1000) / a; let w = x * x; sellers.push((mi, gi, w)); sum += w; if low.is_none_or(|l| a < l) { low = Some(a); }
        }
        if sellers.is_empty() || sum == 0 { return; }
        let boost: u128 = if self.event.as_ref().is_some_and(|e| e.token == token && e.mult > 10_000) { 3 } else { 2 };
        let elastic = 40u128.max(160u128.min((usual * 100) / low.unwrap()));
        let want = (((((((room * 1000 * cfg.town_demand_bp as u128 * part) / 100 / BP) * boost) / 2) * mood) / 100) * elastic) / 100;
        for (mi, gi, w) in sellers {
            let g = &mut self.merchants[mi].goods[gi]; g.carry += (want * w) / sum; let q = (g.carry / 1000).min(g.stock); g.carry -= q * 1000; if g.carry > 8000 { g.carry = 8000; }
            if q > 0 { if let Some((gold, curve)) = self.quote_sale(mi, gi, q, now) { if gold <= self.treasury { self.treasury -= gold; self.apply_sale(mi, gi, q, gold, curve); self.sub_supply(&token, q); } } }
        }
    }
    /// food rots, and now and then a stall has a bad day
    fn wear(&mut self) {
        let (mishap, loss) = (self.cfg.mishap_bp, self.cfg.mishap_loss_bp as u128);
        for mi in 0..self.merchants.len() {
            for gi in 0..self.merchants[mi].goods.len() {
                let token = self.merchants[mi].goods[gi].token.clone(); let rot = self.goods[self.gi(&token)].rot_bp as u128;
                if rot > 0 { let g = &mut self.merchants[mi].goods[gi]; let gone = ceil_div(g.stock * rot, BP).min(g.stock); g.stock -= gone; self.sub_supply(&token, gone); }
            }
            if self.merchants[mi].open && self.next_rnd() % 10_000 < mishap {
                let n = self.merchants[mi].goods.len() as u32; let gi = (self.next_rnd() % n) as usize; let (token, lost) = { let g = &mut self.merchants[mi].goods[gi]; let lost = (g.stock * loss) / BP; g.stock -= lost; (g.token.clone(), lost) };
                self.sub_supply(&token, lost); event("mishap", json!({ "merchant": self.merchants[mi].id, "token": token, "lost": s(lost), "tick": self.tick }));
            }
        }
    }
    /// ten minutes in the life of the market (market_sim.js, tick)
    pub(crate) fn tick_inner(&mut self, now: u64) {
        let cfg = self.cfg.clone(); self.tick += 1;
        for i in 0..self.goods.len() {
            let token = self.goods[i].token.clone(); let usual = self.goods[i].usual.0; let refp = match &self.event { Some(e) if e.token == token => (usual * e.mult as u128) / BP, _ => usual };
            let w = self.world[i] as i128; let walk = cfg.walk_bp as i128; let r = (self.next_rnd() % (cfg.walk_bp * 2 + 1)) as i128 - walk;
            let nw = w + (w * r) / BP as i128 + ((refp as i128 - w) * cfg.revert_bp as i128) / BP as i128; self.world[i] = (usual as i128 / 3).max((usual as i128 * 3).min(nw)) as u128;
        }
        if self.event.as_ref().is_some_and(|e| self.tick >= e.until) { let e = self.event.take().unwrap(); event("event_end", json!({ "index": e.index, "tick": self.tick })); }
        if self.event.is_none() && self.next_rnd() % 10_000 < cfg.event_chance_bp {
            let idx = self.next_rnd() % self.events.len() as u32; let d = self.events[idx as usize].clone(); let span = cfg.event_min_ticks + (self.next_rnd() % (cfg.event_max_ticks - cfg.event_min_ticks + 1));
            self.event = Some(WorldEvent { index: idx, token: d.token.clone(), mult: d.mult, until: self.tick + span as u64 }); event("event", json!({ "index": idx, "token": d.token, "mult": d.mult, "tick": self.tick }));
        }
        if self.tick % cfg.day_ticks == 0 {
            for mi in 0..self.merchants.len() {
                if self.merchants[mi].open {
                    let rent = cfg.rent_millis.0;
                    if self.merchants[mi].till < rent { self.close_stall(mi); }
                    else { let m = &mut self.merchants[mi]; m.till -= rent; let fat = if m.till > m.start_till * 2 { ((m.till - m.start_till * 2) * cfg.levy_bp as u128) / BP } else { 0 }; m.till -= fat; self.treasury += rent + fat; }
                }
                self.repay(mi);
                let m = &mut self.merchants[mi]; m.day_till = m.till; m.caravan_spent = 0; for g in m.goods.iter_mut() { g.day_base = g.base; g.day_target = g.target; g.sold_yesterday = g.sold_today; g.sold_today = 0; }
            }
        }
        let hour = (((self.tick % cfg.day_ticks) * 24) / cfg.day_ticks) as usize; let part = DAY_PART[hour]; let mood = 10u128.max(150u128.min((self.treasury * 100) / cfg.treasury_ref_millis.0));
        for tix in 0..self.goods.len() { self.town_buys(tix, part, mood, now); }
        self.wear();
        for mi in 0..self.merchants.len() { if self.merchants[mi].open && (self.tick + mi as u64) % 6 == 0 && self.tick as i64 - self.merchants[mi].last_ai_tick > 12 { self.rulebook(mi); } }
        self.rescues();
    }

    // ── what a player does: the same for a signed intent and for a wallet calling `act` ──
    fn partner_key(mid: &AccountId, who: &AccountId) -> String { format!("{}|{}", mid, who) }
    fn take_gold(&mut self, who: &AccountId, gold: u128) -> Result<(), String> { let b = self.bal(GOLD, who); if b < gold { return Err("not enough gold".into()); } self.set_bal(GOLD, who, b - gold); Ok(()) }
    fn give_gold(&mut self, who: &AccountId, gold: u128) { let b = self.bal(GOLD, who); self.set_bal(GOLD, who, b + gold); }
    fn do_action(&mut self, who: &AccountId, a: Action, now: u64) -> Result<Value, String> {
        match a {
            Action::Sell { merchant, token, amount, min_gold } => {
                let mi = self.mi(&merchant).ok_or("no such merchant")?; if !self.merchants[mi].open { return Err("that stall is closed".into()); }
                let gi = self.merchants[mi].goods.iter().position(|g| g.token == token).ok_or("they do not deal in that")?; let have = self.bal(&token, who); if have < amount.0 { return Err("you have not got that many".into()); }
                let snap = self.merchants[mi].clone(); let (snap_tr, snap_pool, snap_trades) = (self.treasury, self.pool, self.trades); let mut gold = self.merchant_buys(mi, gi, amount.0, now)?;
                if gold < min_gold.0 { self.merchants[mi] = snap; self.treasury = snap_tr; self.pool = snap_pool; self.trades = snap_trades; return Err("the price moved".into()); }
                { let off = self.take_haggle(&merchant, who, now); if off > 0 { let g = &snap.goods[gi]; let curve = curve_sell(g.base, g.target, g.stock, amount.0); let up = ((gold * off) / BP).min(curve.saturating_sub(gold)).min(self.merchants[mi].till); if up > 0 { self.merchants[mi].till -= up; gold += up; } } }
                self.set_bal(&token, who, have - amount.0); self.give_gold(who, gold);
                nep245("mt_transfer", json!({ "old_owner_id": who, "new_owner_id": merchant, "token_ids": [token], "amounts": [amount] })); nep245("mt_transfer", json!({ "old_owner_id": merchant, "new_owner_id": who, "token_ids": [GOLD], "amounts": [s(gold)] }));
                event("trade", json!({ "merchant": merchant, "who": who, "side": "sell", "token": token, "amount": amount, "gold": s(gold) })); Ok(json!({ "gold": s(gold) }))
            }
            Action::Buy { merchant, token, amount, max_gold } => {
                let mi = self.mi(&merchant).ok_or("no such merchant")?; if !self.merchants[mi].open { return Err("that stall is closed".into()); }
                let gi = self.merchants[mi].goods.iter().position(|g| g.token == token).ok_or("they do not deal in that")?;
                let (quoted, curve) = self.quote_sale(mi, gi, amount.0, now).ok_or("they have not got that many")?; let off = self.take_haggle(&merchant, who, now); let gold = curve.max(quoted.saturating_sub((quoted * off) / BP)); if gold > max_gold.0 { return Err("the price moved".into()); }
                self.take_gold(who, gold)?; self.apply_sale(mi, gi, amount.0, gold, curve); let b = self.bal(&token, who); self.set_bal(&token, who, b + amount.0);
                nep245("mt_transfer", json!({ "old_owner_id": merchant, "new_owner_id": who, "token_ids": [token], "amounts": [amount] })); nep245("mt_transfer", json!({ "old_owner_id": who, "new_owner_id": merchant, "token_ids": [GOLD], "amounts": [s(gold)] }));
                event("trade", json!({ "merchant": merchant, "who": who, "side": "buy", "token": token, "amount": amount, "gold": s(gold) })); Ok(json!({ "gold": s(gold) }))
            }
            Action::Ship { token, amount } => {
                if token == GOLD { return Err("gold stays at the market".into()); } let have = self.bal(&token, who); if have < amount.0 { return Err("you have not got that many".into()); }
                self.set_bal(&token, who, have - amount.0); self.sub_supply(&token, amount.0); nep245("mt_burn", json!({ "owner_id": who, "token_ids": [token], "amounts": [amount], "memo": "sent home to the camp" })); Ok(json!({ "shipped": amount }))
            }
            Action::Invest { merchant, gold } => {
                let mi = self.mi(&merchant).ok_or("no such merchant")?; if gold.0 == 0 { return Err("nothing to invest".into()); } self.take_gold(who, gold.0)?;
                let reopen = self.cfg.reopen_millis.0; let key = Self::partner_key(&merchant, who); let mut p = self.partners.get(&key).cloned().unwrap_or_default();
                let closed_bp = self.cfg.closed_goods_bp; let m = &mut self.merchants[mi]; let total = m.founder_shares + m.partner_shares; let shares = 1u128.max((gold.0 * total) / Self::stake_worth(m, closed_bp).max(1));
                m.till += gold.0; p.owed += (p.shares * m.acc) / ACC - p.debt; p.shares += shares; p.debt = (p.shares * m.acc) / ACC; m.partner_shares += shares;
                let reopened = !m.open && m.till >= reopen; if reopened { m.open = true; } self.partners.insert(key, p);
                event("invest", json!({ "merchant": merchant, "who": who, "gold": gold, "shares": s(shares), "reopened": reopened })); Ok(json!({ "shares": s(shares), "reopened": reopened }))
            }
            Action::Collect { merchant } => {
                let mi = self.mi(&merchant).ok_or("no such merchant")?; let key = Self::partner_key(&merchant, who); let mut p = self.partners.get(&key).cloned().ok_or("you are not a partner there")?; let acc = self.merchants[mi].acc;
                let due = (p.owed + (p.shares * acc) / ACC - p.debt).min(self.pool); p.owed = 0; p.debt = (p.shares * acc) / ACC; self.partners.insert(key, p); self.pool -= due; self.give_gold(who, due);
                event("collect", json!({ "merchant": merchant, "who": who, "gold": s(due) })); Ok(json!({ "gold": s(due) }))
            }
            Action::Give { to, token, amount } => {
                if self.mi(&to).is_some() { return Err("a merchant takes goods by trade".into()); } let have = self.bal(&token, who); if have < amount.0 { return Err("you have not got that many".into()); }
                self.set_bal(&token, who, have - amount.0); let b = self.bal(&token, &to); self.set_bal(&token, &to, b + amount.0); nep245("mt_transfer", json!({ "old_owner_id": who, "new_owner_id": to, "token_ids": [token], "amounts": [amount] })); Ok(json!({ "given": amount }))
            }
            Action::RevokeWarden {} => { self.no_warden.insert(who.clone()); event("warden_revoked", json!({ "who": who })); Ok(json!({ "revoked": true })) }
            Action::AppointSteward { key, gold_per_day } => { let day = self.tick / self.cfg.day_ticks; let spent = self.stewards.get(who).filter(|o| o.day == day).map_or(0, |o| o.spent); self.stewards.insert(who.clone(), Steward { key: key.clone(), cap: gold_per_day.0, day, spent, trades: 0 }); event("steward", json!({ "who": who, "key": key, "gold_per_day": gold_per_day })); Ok(json!({ "appointed": true })) }
            Action::DismissSteward {} => { self.stewards.remove(who); event("steward_gone", json!({ "who": who })); Ok(json!({ "dismissed": true })) }
        }
    }
    /// check one signed intent (NEP-413) and do what it says: returns "ok" or why not. A bad intent costs only itself, the rest of the batch goes on
    fn run_signed(&mut self, si: SignedIntent, now: u64) -> Value {
        let run = |this: &mut Self| -> Result<Vec<Value>, String> {
            if si.recipient != env::current_account_id().as_str() { return Err("this intent is for another contract".into()); }
            let nonce: [u8; 32] = si.nonce.0.as_slice().try_into().map_err(|_| "a nonce is 32 bytes")?; let sig: [u8; 64] = si.signature.0.as_slice().try_into().map_err(|_| "a signature is 64 bytes")?;
            let pk = si.public_key.as_bytes(); if pk.len() != 33 || pk[0] != 0 { return Err("ed25519 keys only".into()); } let pk32: [u8; 32] = pk[1..33].try_into().unwrap();
            let mut buf = Vec::with_capacity(si.message.len() + si.recipient.len() + 48);
            buf.extend_from_slice(&2147484061u32.to_le_bytes()); buf.extend_from_slice(&(si.message.len() as u32).to_le_bytes()); buf.extend_from_slice(si.message.as_bytes()); buf.extend_from_slice(&nonce); buf.extend_from_slice(&(si.recipient.len() as u32).to_le_bytes()); buf.extend_from_slice(si.recipient.as_bytes()); buf.push(0);
            if !env::ed25519_verify(&sig, &env::sha256_array(&buf), &pk32) { return Err("bad signature".into()); }
            let msg: IntentMessage = serde_json::from_str(&si.message).map_err(|_| "cannot read the intent")?;
            if now > msg.deadline_ms { return Err("too late".into()); }
            let is_own = msg.signer.as_str() == hex(&pk32); let registered = this.keys.get(&msg.signer).is_some_and(|v| v.contains(&si.public_key)); let steward = !is_own && !registered && this.stewards.get(&msg.signer).is_some_and(|g| g.key == si.public_key);
            if !is_own && !registered && !steward { return Err("that key does not belong to this account".into()); }
            if msg.seq <= *this.seq.get(&msg.signer).unwrap_or(&0) { return Err("already seen".into()); }
            this.seq.insert(msg.signer.clone(), msg.seq);
            let mut out = Vec::new();
            for a in msg.actions {
                if steward {
                    // THE STEWARD'S LEASH: it can sell, buy and send home; a purchase can only promise what is left of today's limit, and what it really paid is what counts
                    let day = this.tick / this.cfg.day_ticks; let mut g = this.stewards.get(&msg.signer).cloned().ok_or("dismissed")?; if g.day != day { g.day = day; g.spent = 0; }
                    match &a {
                        Action::Sell { .. } | Action::Ship { .. } => { out.push(this.do_action(&msg.signer, a, now)?); g.trades += 1; }
                        Action::Buy { max_gold, .. } => { if max_gold.0 > g.cap.saturating_sub(g.spent) { event("steward_stopped", json!({ "who": msg.signer, "asked": max_gold, "left": s(g.cap.saturating_sub(g.spent)) })); return Err("over the steward's limit".into()); } let r = this.do_action(&msg.signer, a, now)?; let paid: u128 = r.get("gold").and_then(|x| x.as_str()).and_then(|x| x.parse().ok()).unwrap_or(0); g.spent += paid; g.trades += 1; out.push(r); }
                        _ => return Err("a steward cannot do that".into()),
                    }
                    this.stewards.insert(msg.signer.clone(), g);
                } else { out.push(this.do_action(&msg.signer, a, now)?); }
            }
            Ok(out)
        };
        match run(self) { Ok(v) => json!({ "ok": v }), Err(e) => json!({ "err": e }) }
    }
    /// A merchant's decision: everything it asks for goes through the leash, and every cut is logged
    fn apply_decision(&mut self, mi: usize, d: &Value, sealed: bool, model: &str, now: u64) {
        let cfg = self.cfg.clone(); let mut pulled: Vec<Value> = Vec::new(); let id = self.merchants[mi].id.clone();
        if let Some(list) = d.get("goods").and_then(|x| x.as_array()) { for it in list.iter().take(8) {
            let Some(token) = it.get("good").and_then(|x| x.as_str()) else { continue }; let Some(gi) = self.merchants[mi].goods.iter().position(|g| g.token == token) else { continue }; let usual = self.usual(token);
            let g = &mut self.merchants[mi].goods[gi];
            if let Some(p) = it.get("price").and_then(|x| x.as_i64()) { let want = g.base as i128 + (g.base as i128 * p.clamp(-90, 400) as i128) / 100; let got = Self::leash_base(&cfg, usual, g, want); if got as i128 != want { pulled.push(json!({ "good": token, "asked": "price", "wanted": want.to_string(), "allowed": s(got) })); } g.base = got; }
            if let Some(p) = it.get("stock").and_then(|x| x.as_i64()) { let want = g.target as i128 + (g.target as i128 * p.clamp(-90, 400) as i128) / 100; let got = Self::leash_target(&cfg, g, want); if got as i128 != want { pulled.push(json!({ "good": token, "asked": "stock", "wanted": want.to_string(), "allowed": s(got) })); } g.target = got; }
            if let Some(p) = it.get("margin").and_then(|x| x.as_i64()) { let want = p.clamp(0, 100) * 100; let got = want.clamp(cfg.spread_min_bp as i64, cfg.spread_max_bp as i64); if got != want { pulled.push(json!({ "good": token, "asked": "margin", "wanted": want, "allowed": got })); } g.spread_bp = got as u32; }
        } }
        let budget = |m: &Merchant| ((m.day_till * cfg.caravan_day_bp as u128) / BP).saturating_sub(m.caravan_spent);
        if let Some(list) = d.get("caravan").and_then(|x| x.as_array()) { for it in list.iter().take(4) {
            let Some(token) = it.get("good").and_then(|x| x.as_str()) else { continue }; let Some(gi) = self.merchants[mi].goods.iter().position(|g| g.token == token) else { continue };
            if let Some(q) = it.get("buy").and_then(|x| x.as_u64()) { let w = self.world_of(token); let unit = ((w * (BP + cfg.tariff_bp as u128)) / BP).max(1); let m = &self.merchants[mi]; let can = (budget(m).min(m.till) / unit).min(q as u128); if can < q as u128 { pulled.push(json!({ "good": token, "asked": "caravan", "wanted": q, "allowed": s(can) })); } self.caravan_buy(mi, gi, can); }
            if let Some(q) = it.get("sell").and_then(|x| x.as_u64()) { self.caravan_sell(mi, gi, q as u128); }
        } }
        if let Some(deal) = d.get("deal") { if let (Some(from), Some(token), Some(q)) = (deal.get("from").and_then(|x| x.as_str()), deal.get("good").and_then(|x| x.as_str()), deal.get("qty").and_then(|x| x.as_u64())) {
            let seller = self.merchants.iter().position(|o| o.id.as_str().split('.').next() == Some(from));
            if let (Some(si), Some(gi)) = (seller.filter(|&x| x != mi && self.merchants[x].open), self.merchants[mi].goods.iter().position(|g| g.token == token)) { if let Some(sgi) = self.merchants[si].goods.iter().position(|g| g.token == token) {
                if let Some((gold, curve)) = self.quote_sale(si, sgi, q as u128, now) { let m = &self.merchants[mi]; if gold <= budget(m).min(m.till) { self.merchants[mi].till -= gold; self.merchants[mi].caravan_spent += gold; self.apply_sale(si, sgi, q as u128, gold, curve); self.merchants[mi].goods[gi].stock += q as u128; event("deal", json!({ "buyer": id, "seller": self.merchants[si].id, "token": token, "amount": q, "gold": s(gold) })); } else { pulled.push(json!({ "good": token, "asked": "deal", "wanted": q, "allowed": 0 })); } }
            } }
        } }
        let fee = cfg.think_fee_millis.0.min(self.merchants[mi].till); self.merchants[mi].till -= fee; self.treasury += fee;
        let say = d.get("say").and_then(|x| x.as_str()).unwrap_or(""); let why = d.get("why").and_then(|x| x.as_str()).unwrap_or(""); let t = self.tick as i64; let m = &mut self.merchants[mi];
        m.say = cut(say, 140); m.decisions += 1; if sealed { m.sealed += 1; } m.pulled += pulled.len() as u32; m.last_ai_tick = t;
        event("decision", json!({ "merchant": id, "tick": t, "sealed": sealed, "model": cut(model, 60), "say": m.say, "why": cut(why, 400), "pulled": pulled }));
    }
    /// read the decision out of an answer from the model: the JSON object in the message's content
    fn decision_from_answer(response: &str) -> Option<(Value, String)> {
        let r: Value = serde_json::from_str(response).ok()?; let model = r.get("model").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let content = r.get("choices")?.get(0)?.get("message")?.get("content")?.as_str()?; let (a, b) = (content.find('{')?, content.rfind('}')?); if b < a { return None; }
        Some((serde_json::from_str(&content[a..=b]).ok()?, model))
    }
    fn view_merchant(&self, m: &Merchant, now: u64) -> Value {
        json!({ "id": m.id, "name": m.name, "open": m.open, "till": s(m.till), "start_till": s(m.start_till), "say": m.say, "decisions": m.decisions, "sealed": m.sealed, "pulled": m.pulled, "last_ai_tick": m.last_ai_tick, "closed_at": m.closed_at, "prompt_hash": m.prompt_hash,
            "founder_shares": s(m.founder_shares), "partner_shares": s(m.partner_shares), "acc": s(m.acc), "care": m.care, "greed": m.greed, "nerve": m.nerve, "day_till": s(m.day_till), "caravan_spent": s(m.caravan_spent), "loan": m.loan.as_ref().map(|l| json!({ "from": l.from, "amount": s(l.amount) })),
            "goods": m.goods.iter().map(|g| { let dt = now.saturating_sub(g.heat_ms); json!({ "token": g.token, "base": s(g.base), "target": s(g.target), "stock": s(g.stock), "spread_bp": g.spread_bp, "buy_heat": s(heat_now(g.buy_heat, dt, self.cfg.heat_half_ms)), "sell_heat": s(heat_now(g.sell_heat, dt, self.cfg.heat_half_ms)), "heat_ms": now, "day_base": s(g.day_base), "day_target": s(g.day_target), "start_target": s(g.start_target), "sold_today": s(g.sold_today), "sold_yesterday": s(g.sold_yesterday) }) }).collect::<Vec<_>>() })
    }
}

#[near]
impl Market {
    /// Open the market. All the numbers come from market_rules.js (near/scripts/setup.js passes them), so the file that says what they are is what is on the chain.
    #[init]
    pub fn new(owner: AccountId, warden: AccountId, cfg: Config, goods: Vec<GoodDef>, events: Vec<EventDef>, merchants: Vec<MerchantDef>, treasury: U128, seed: u32) -> Self {
        let world: Vec<u128> = goods.iter().map(|g| g.usual.0).collect(); let mut supply = vec![0u128; goods.len()]; let now = env::block_timestamp_ms(); let mut gold_supply = treasury.0;
        let ms = merchants.into_iter().map(|d| { gold_supply += d.till.0;
            let gs = d.goods.iter().map(|token| { let i = goods.iter().position(|g| &g.token == token).unwrap_or_else(|| env::panic_str("a merchant deals in an unknown good")); let usual = goods[i].usual.0; let target = 240_000 / usual; supply[i] += target;
                Good { token: token.clone(), base: usual, target, stock: target, spread_bp: d.greed, buy_heat: 0, sell_heat: 0, heat_ms: 0, day_base: usual, day_target: target, start_target: target, carry: 0, sold_today: 0, sold_yesterday: 0 } }).collect();
            Merchant { id: d.id, name: d.name, till: d.till.0, start_till: d.till.0, open: true, goods: gs, care: d.care, greed: d.greed, nerve: d.nerve, day_till: d.till.0, caravan_spent: 0, founder_shares: 1_000_000, partner_shares: 0, acc: 0, closed_at: 0, last_ai_tick: -100_000, say: String::new(), decisions: 0, sealed: 0, pulled: 0, loan: None, prompt_hash: d.prompt_hash } }).collect();
        Self { owner, warden, cfg, frozen: false, tick: 0, last_tick_ms: now, rng: seed, goods, world, supply, events, event: None, treasury: treasury.0, pool: 0, merchants: ms, signers: Vec::new(), gold_supply,
            balances: LookupMap::new(Key::Balances), partners: LookupMap::new(Key::Partners), keys: LookupMap::new(Key::Keys), seq: LookupMap::new(Key::Seq), started: LookupSet::new(Key::Started), no_warden: LookupSet::new(Key::NoWarden), camp_day: LookupMap::new(Key::CampDay), stewards: LookupMap::new(Key::Stewards), haggles: LookupMap::new(Key::Haggles), trades: 0, busts: 0 }
    }

    /// Ten minutes pass. Anyone can call this, and needs nobody's leave: the market goes on without the game's server.
    pub fn crank(&mut self) -> u64 {
        let now = env::block_timestamp_ms(); require!(now >= self.last_tick_ms + self.cfg.tick_ms, "not yet");
        let seed = env::random_seed_array(); self.rng ^= u32::from_le_bytes([seed[0], seed[1], seed[2], seed[3]]); self.last_tick_ms += self.cfg.tick_ms; if now > self.last_tick_ms + 36 * self.cfg.tick_ms { self.last_tick_ms = now; }
        self.tick_inner(now); self.tick
    }

    /// Signed intents from players, in a batch: anyone may bring them to the chain, and pays the gas. Returns what became of each.
    pub fn execute_intents(&mut self, signed: Vec<SignedIntent>) -> Vec<Value> { let now = env::block_timestamp_ms(); signed.into_iter().map(|si| self.run_signed(si, now)).collect() }

    /// The game's warden brings goods a camp sent (within the day's cap), gives a new player their purse, and brings signed intents, all in one go.
    pub fn serve(&mut self, brings: Vec<Bring>, starters: Vec<AccountId>, signed: Vec<SignedIntent>) -> Vec<Value> {
        require!(env::predecessor_account_id() == self.warden, "the warden's work"); let now = env::block_timestamp_ms(); let day = self.tick / self.cfg.day_ticks; let cap = self.cfg.credit_day.0;
        for a in starters { if self.started.insert(a.clone()) { let g = self.cfg.starter_gold_millis.0.min(self.treasury); self.treasury -= g; self.give_gold(&a, g); event("starter", json!({ "who": a, "gold": s(g) })); } }
        for b in brings {
            if b.token == GOLD { continue; } let i = self.gi(&b.token); let mut c = self.camp_day.get(&b.account).cloned().filter(|c| c.day == day).unwrap_or(CampDay { day, brought: Vec::new() });
            let pos = c.brought.iter().position(|x| x.0 == b.token); let so_far = pos.map_or(0, |p| c.brought[p].1); let q = b.amount.0.min(cap.saturating_sub(so_far)); if q == 0 { continue; }
            match pos { Some(p) => c.brought[p].1 += q, None => c.brought.push((b.token.clone(), q)) } self.camp_day.insert(b.account.clone(), c);
            let v = self.bal(&b.token, &b.account); self.set_bal(&b.token, &b.account, v + q); self.supply[i] += q; nep245("mt_mint", json!({ "owner_id": b.account, "token_ids": [b.token], "amounts": [s(q)], "memo": "brought from the camp" }));
        }
        signed.into_iter().map(|si| self.run_signed(si, now)).collect()
    }
    /// A second device of the same player: the warden, who has checked their Telegram identity, adds its key. The player can take this power away (Action::RevokeWarden).
    pub fn add_device_key(&mut self, account: AccountId, key: PublicKey) {
        require!(env::predecessor_account_id() == self.warden, "the warden's work"); require!(!self.no_warden.contains(&account), "this player has taken that power away");
        let mut v = self.keys.get(&account).cloned().unwrap_or_default(); require!(v.len() < 8, "too many devices"); if !v.contains(&key) { v.push(key.clone()); self.keys.insert(account.clone(), v); } event("device_key", json!({ "account": account, "key": key }));
    }
    /// A player with their own wallet can act directly, with no intent and no relay.
    pub fn act(&mut self, actions: Vec<Action>) -> Vec<Value> { let who = env::predecessor_account_id(); let now = env::block_timestamp_ms(); actions.into_iter().map(|a| self.do_action(&who, a, now).unwrap_or_else(|e| env::panic_str(&e))).collect() }

    /// A MERCHANT'S SEALED DECISION: NEAR AI's answer with the proof it gives. The chain itself checks that the secure hardware signed exactly this request and answer, that the merchant's character is the one pinned here, and that this is an answer about the market as it is now. Only the merchant's own key can bring it.
    pub fn decide_sealed(&mut self, answer: SealedAnswer) {
        let id = env::predecessor_account_id(); let mi = self.mi(&id).unwrap_or_else(|| env::panic_str("only a merchant decides"));
        let sig = unhex(&answer.signature).unwrap_or_default(); require!(sig.len() == 65, "a signature is 65 bytes");
        let signer = answer.signer.to_lowercase(); require!(self.signers.contains(&signer), "that key is not attested");
        let parts: Vec<&str> = answer.text.rsplitn(3, ':').collect(); require!(parts.len() >= 2, "the signed text has the two hashes");
        require!(parts[1] == hex(&env::sha256_array(answer.request.as_bytes())), "the signature is for another request"); require!(parts[0] == hex(&env::sha256_array(answer.response.as_bytes())), "the signature is for another answer");
        let mut prefixed = format!("\x19Ethereum Signed Message:\n{}", answer.text.len()).into_bytes(); prefixed.extend_from_slice(answer.text.as_bytes()); let h = env::keccak256_array(&prefixed);
        let v = if sig[64] >= 27 { sig[64] - 27 } else { sig[64] }; let pk = env::ecrecover(&h, &sig[..64], v, false).unwrap_or_else(|| env::panic_str("the signature does not recover")); let addr = env::keccak256_array(&pk);
        require!(format!("0x{}", hex(&addr[12..])) == signer, "the signature is not that key's");
        let req: Value = serde_json::from_str(&answer.request).unwrap_or_else(|_| env::panic_str("cannot read the request"));
        let system = req.get("messages").and_then(|m| m.get(0)).and_then(|m| m.get("content")).and_then(|c| c.as_str()).unwrap_or(""); let user = req.get("messages").and_then(|m| m.get(1)).and_then(|m| m.get("content")).and_then(|c| c.as_str()).unwrap_or("");
        if let Some(pin) = &self.merchants[mi].prompt_hash { require!(&hex(&env::sha256_array(system.as_bytes())) == pin, "that is not this merchant's character"); }
        let asked: u64 = user.strip_prefix("tick ").and_then(|r| r.split_whitespace().next()).and_then(|n| n.parse().ok()).unwrap_or(0); require!(asked + 2 >= self.tick && asked <= self.tick, "that answer is about another moment");
        require!((self.merchants[mi].last_ai_tick) < asked as i64 || self.merchants[mi].last_ai_tick < 0, "this merchant has already decided for that moment");
        let (d, model) = Self::decision_from_answer(&answer.response).unwrap_or_else(|| env::panic_str("cannot read the decision")); self.apply_decision(mi, &d, true, &model, env::block_timestamp_ms());
    }
    /// THE HAGGLE: what a merchant's AI says after a player has talked to it. It comes off the margin of that player's next trade with this merchant, within five minutes; the most it can be is the merchant's own margin, and a trade never passes the merchant's own price.
    pub fn give_haggle(&mut self, buyer: AccountId, off_bp: u32) {
        let id = env::predecessor_account_id(); require!(self.mi(&id).is_some(), "only a merchant haggles"); let bp = off_bp.min(3000); let until = env::block_timestamp_ms() + 300_000; if bp == 0 { self.haggles.remove(&Self::partner_key(&id, &buyer)); } else { self.haggles.insert(Self::partner_key(&id, &buyer), (bp, until)); }
        event("haggle", json!({ "merchant": id, "buyer": buyer, "off_bp": bp, "asked_bp": off_bp, "until": until }));
    }
    /// A decision with no seal (a model that gives no proof, or the proof is not to be had): the leash is the same, and the chain says it was not sealed.
    pub fn decide(&mut self, decision: String, model: String) {
        let id = env::predecessor_account_id(); let mi = self.mi(&id).unwrap_or_else(|| env::panic_str("only a merchant decides"));
        let d: Value = serde_json::from_str(&decision).unwrap_or_else(|_| env::panic_str("cannot read the decision")); self.apply_decision(mi, &d, false, &model, env::block_timestamp_ms());
    }

    // ── the owner's work ──
    /// A TEE signing key has been attested: the attestation report's hash goes on the chain, so anyone can fetch that report and check it.
    pub fn add_signer(&mut self, address: String, report_sha256: String) { let p = env::predecessor_account_id(); require!(p == self.owner || p == self.warden, "the owner's work"); let a = address.to_lowercase(); if !self.signers.contains(&a) { self.signers.push(a.clone()); if self.signers.len() > 32 { self.signers.remove(0); } } event("signer", json!({ "address": a, "report_sha256": report_sha256 })); }
    pub fn set_config(&mut self, cfg: Config) { require!(env::predecessor_account_id() == self.owner, "the owner's work"); require!(!self.frozen, "the market's numbers are frozen"); self.cfg = cfg; event("config", json!({ "by": self.owner })); }
    /// The market's numbers can never change again.
    pub fn freeze(&mut self) { require!(env::predecessor_account_id() == self.owner, "the owner's work"); self.frozen = true; event("frozen", json!({ "tick": self.tick })); }
    pub fn set_prompt(&mut self, merchant: AccountId, prompt_hash: String) { require!(env::predecessor_account_id() == self.owner, "the owner's work"); require!(!self.frozen, "the market's numbers are frozen"); let mi = self.mi(&merchant).unwrap_or_else(|| env::panic_str("no such merchant")); self.merchants[mi].prompt_hash = Some(prompt_hash.clone()); event("prompt", json!({ "merchant": merchant, "sha256": prompt_hash })); }

    // ── what anyone can read ──
    /// The whole market in one read.
    pub fn state(&self) -> Value {
        let now = env::block_timestamp_ms();
        json!({ "tick": self.tick, "now_ms": now, "last_tick_ms": self.last_tick_ms, "treasury": s(self.treasury), "pool": s(self.pool), "gold_supply": s(self.gold_supply), "trades": self.trades, "busts": self.busts, "frozen": self.frozen,
            "world": self.goods.iter().enumerate().map(|(i, g)| json!({ "token": g.token, "usual": g.usual, "world": s(self.world[i]), "supply": s(self.supply[i]) })).collect::<Vec<_>>(),
            "event": self.event.as_ref().map(|e| json!({ "index": e.index, "token": e.token, "mult": e.mult, "until": e.until })), "merchants": self.merchants.iter().map(|m| self.view_merchant(m, now)).collect::<Vec<_>>(), "signers": self.signers })
    }
    pub fn get_config(&self) -> Config { self.cfg.clone() }
    /// A player's purse and crates, what they hold in each stall, and the next number to sign with.
    pub fn player(&self, account: AccountId) -> Value {
        let items: Vec<Value> = std::iter::once(GOLD.to_string()).chain(self.goods.iter().map(|g| g.token.clone())).map(|t| json!({ "token": t, "amount": s(self.bal(&t, &account)) })).collect();
        let parts: Vec<Value> = self.merchants.iter().filter_map(|m| { let p = self.partners.get(&Self::partner_key(&m.id, &account))?; let due = (p.owed + (p.shares * m.acc) / ACC).saturating_sub(p.debt); Some(json!({ "merchant": m.id, "shares": s(p.shares), "due": s(due), "of": s(m.founder_shares + m.partner_shares) })) }).collect();
        json!({ "account": account, "items": items, "partners": parts, "seq": self.seq.get(&account).unwrap_or(&0), "started": self.started.contains(&account), "warden_revoked": self.no_warden.contains(&account), "haggles": self.merchants.iter().filter_map(|m| self.haggles.get(&Self::partner_key(&m.id, &account)).map(|h| json!({ "merchant": m.id, "off_bp": h.0, "until": h.1 }))).collect::<Vec<_>>(), "steward": self.stewards.get(&account).map(|g| { let d = self.tick / self.cfg.day_ticks; json!({ "key": g.key, "cap": s(g.cap), "spent": s(if g.day == d { g.spent } else { 0 }), "trades": g.trades }) }) })
    }
    /// What a trade would pay right now, by the market's own sums.
    pub fn quote(&self, merchant: AccountId, token: String, side: String, amount: U128) -> Option<U128> {
        let now = env::block_timestamp_ms(); let m = self.merchants.iter().find(|m| m.id == merchant)?; let g = m.goods.iter().find(|g| g.token == token)?; let dt = now.saturating_sub(g.heat_ms);
        if side == "sell" { let c = curve_sell(g.base, g.target, g.stock, amount.0); let off = g.spread_bp as u128 / 2 + heat_now(g.sell_heat, dt, self.cfg.heat_half_ms); if off >= BP { None } else { Some(U128((c * (BP - off)) / BP)) } }
        else { let c = curve_buy(g.base, g.target, g.stock, amount.0)?; Some(U128(ceil_div(c * (BP + g.spread_bp as u128 / 2 + heat_now(g.buy_heat, dt, self.cfg.heat_half_ms)), BP))) }
    }

    // ── NEP-245: every good, and gold, is a token of this one contract ──
    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        if account_id == env::current_account_id() && token_id == GOLD { return U128(self.treasury + self.pool); }
        if let Some(m) = self.merchants.iter().find(|m| m.id == account_id) { return U128(if token_id == GOLD { m.till } else { m.goods.iter().find(|g| g.token == token_id).map_or(0, |g| g.stock) }); }
        U128(self.bal(&token_id, &account_id))
    }
    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> { token_ids.into_iter().map(|t| self.mt_balance_of(account_id.clone(), t)).collect() }
    pub fn mt_supply(&self, token_id: String) -> Option<U128> { if token_id == GOLD { return Some(U128(self.gold_supply)); } self.goods.iter().position(|g| g.token == token_id).map(|i| U128(self.supply[i])) }
    pub fn mt_batch_supply(&self, token_ids: Vec<String>) -> Vec<Option<U128>> { token_ids.into_iter().map(|t| self.mt_supply(t)).collect() }
    pub fn mt_token(&self, token_ids: Vec<String>) -> Vec<Option<Value>> { token_ids.into_iter().map(|t| if t == GOLD || self.goods.iter().any(|g| g.token == t) { Some(json!({ "token_id": t, "owner_id": Value::Null })) } else { None }).collect() }
    #[payable]
    pub fn mt_transfer(&mut self, receiver_id: AccountId, token_id: String, amount: U128, approval: Option<(AccountId, u64)>, memo: Option<String>) {
        near_sdk::assert_one_yocto(); require!(approval.is_none(), "this contract has no approvals"); let _ = memo; let who = env::predecessor_account_id(); require!(self.mi(&who).is_none(), "a merchant's goods leave by trade"); require!(self.mi(&receiver_id).is_none(), "a merchant takes goods by trade");
        let r = self.do_action(&who, Action::Give { to: receiver_id, token: token_id, amount }, env::block_timestamp_ms()); if let Err(e) = r { env::panic_str(&e); }
    }
    #[payable]
    pub fn mt_batch_transfer(&mut self, receiver_id: AccountId, token_ids: Vec<String>, amounts: Vec<U128>, approvals: Option<Vec<Option<(AccountId, u64)>>>, memo: Option<String>) {
        near_sdk::assert_one_yocto(); require!(approvals.is_none(), "this contract has no approvals"); require!(token_ids.len() == amounts.len(), "as many amounts as tokens"); let _ = memo; let who = env::predecessor_account_id(); require!(self.mi(&who).is_none(), "a merchant's goods leave by trade"); require!(self.mi(&receiver_id).is_none(), "a merchant takes goods by trade");
        let now = env::block_timestamp_ms(); for (t, a) in token_ids.into_iter().zip(amounts) { if let Err(e) = self.do_action(&who, Action::Give { to: receiver_id.clone(), token: t, amount: a }, now) { env::panic_str(&e); } }
    }
    #[payable]
    pub fn mt_transfer_call(&mut self, receiver_id: AccountId, token_id: String, amount: U128, approval: Option<(AccountId, u64)>, memo: Option<String>, msg: String) -> PromiseOrValue<Vec<U128>> { self.mt_batch_transfer_call(receiver_id, vec![token_id], vec![amount], approval.map(|a| vec![Some(a)]), memo, msg) }
    #[payable]
    pub fn mt_batch_transfer_call(&mut self, receiver_id: AccountId, token_ids: Vec<String>, amounts: Vec<U128>, approvals: Option<Vec<Option<(AccountId, u64)>>>, memo: Option<String>, msg: String) -> PromiseOrValue<Vec<U128>> {
        let sender = env::predecessor_account_id(); self.mt_batch_transfer(receiver_id.clone(), token_ids.clone(), amounts.clone(), approvals, memo);
        let call_gas = env::prepaid_gas().saturating_sub(env::used_gas()).saturating_sub(Gas::from_tgas(20));
        PromiseOrValue::Promise(Promise::new(receiver_id.clone()).function_call("mt_on_transfer".to_string(), json!({ "sender_id": sender, "previous_owner_ids": token_ids.iter().map(|_| sender.clone()).collect::<Vec<_>>(), "token_ids": token_ids, "amounts": amounts, "msg": msg }).to_string().into_bytes(), NearToken::from_yoctonear(0), call_gas)
            .then(Promise::new(env::current_account_id()).function_call("mt_resolve_transfer".to_string(), json!({ "sender_id": sender, "receiver_id": receiver_id, "token_ids": token_ids, "amounts": amounts }).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(15))))
    }
    /// what the receiver did not use comes back to the sender (NEP-245)
    #[private]
    pub fn mt_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, token_ids: Vec<String>, amounts: Vec<U128>) -> Vec<U128> {
        let refund: Vec<U128> = match env::promise_result_checked(0, 1024) { Ok(bytes) => serde_json::from_slice::<Vec<U128>>(&bytes).unwrap_or_else(|_| amounts.clone()), Err(_) => amounts.clone() };
        token_ids.iter().enumerate().map(|(i, t)| { let want = refund.get(i).map_or(0, |r| r.0).min(amounts[i].0); let have = self.bal(t, &receiver_id); let back = want.min(have); if back > 0 { self.set_bal(t, &receiver_id, have - back); let b = self.bal(t, &sender_id); self.set_bal(t, &sender_id, b + back); nep245("mt_transfer", json!({ "old_owner_id": receiver_id, "new_owner_id": sender_id, "token_ids": [t], "amounts": [s(back)], "memo": "refund" })); } U128(amounts[i].0 - back) }).collect()
    }
}

#[cfg(test)]
mod tests;
