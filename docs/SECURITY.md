# Giving an AI money without giving it the keys

Seven AI merchants hold gold and goods. A player's AI agent spends a player's gold. Anyone can type anything at a merchant. This is what holds when all of that goes wrong, and where each limit lives. All of it is in the contract (`near/contract/src/lib.rs`), not in the game's server and not in a prompt.

## Who holds which key

| Key | Held by | It can | It cannot |
|---|---|---|---|
| Merchant's function-call key, on `odin.<root>` | The market's server (derived from one secret) | Call `decide`, `decide_sealed`, `give_haggle` on the market | Transfer NEAR, call anything else, or move gold or goods |
| Warden's function-call keys, on `warden.<root>` | The market's server | Call `serve`, `crank`, `add_device_key`, `add_signer`, `execute_intents` | Spend the warden's NEAR, or sign for a player: every player action needs the player's own signature |
| Player's key | The player's device only | Everything the player can do | |
| Steward's key | The market's server, on the player's word | Sell, buy and ship for that player, up to a limit per day | Invest, give, collect, appoint, or spend past the limit |
| Owner (`<root>`) | The project's owner | `set_config`, `set_prompt`, `add_signer`, `freeze` | Print gold or take a player's goods through the contract: no method does that. `freeze` gives up `set_config` and `set_prompt` for good |

A player can also take the warden out of their account for good: the `revoke_warden` action, after which only their own transactions count.

One power stays outside the contract while this is a practice market: the root account holds a full-access key on `market.<root>`, so its owner could deploy different code. Deleting that key ends it for good, and anyone can check with `near account list-keys`. Until then, the contract's promises hold only as long as the code on the chain is the code in this repository: `near/contract/res/` has the build, and `node near/scripts/check_code.mjs` compares its hash with the chain's.

## What an AI decision can and cannot do

`apply_decision` takes whatever JSON the model produced and treats it as a wish:

- **Price:** at most ±20% of the usual price a day.
- **Stock aim:** at most ±50% a day.
- **Margin:** 2% to 40%.
- **Caravan purchases and deals with rivals:** at most 150% of the morning's till a day.
- **Anything else in the JSON:** ignored.

What it wanted and what it was allowed are both logged in the `decision` event's `pulled` list, on the chain, for anyone to read. A malformed answer changes nothing.

## The seal: what `decide_sealed` checks on-chain

1. The two hashes in the signed text are `sha256` of the exact request and the exact answer.
2. `ecrecover` on the signature gives a key on the market's list of attested keys.
3. `sha256` of the request's system prompt equals the merchant's pinned character hash, so the server cannot quietly tell Odin to be somebody else.
4. The request says `tick N`, and N must be the current tick or one of the last two, so an old answer cannot be replayed.
5. The merchant has not already decided for that moment.

If any of these fails, the transaction fails and no price moves. An unsealed decision (`decide`) is also possible, and is shown as such in the game. It passes through the same leash.

What the seal does not do: it does not prove the facts the merchant was told were true (they are in the request, for anyone to compare with the chain at that tick), and the list of attested keys is kept by the warden, who reads NEAR AI's attestation report. The report's hash goes on the chain with the key.

## Prompt injection, on purpose

Anybody can type anything at a merchant. We expect it to work on the model sometimes, and the game is built so that it does not matter:

- `give_haggle` caps the discount at 30%, for one trade with that merchant, within five minutes.
- At the till the discount only comes out of the merchant's margin. It stops at the price on the merchant's curve. A merchant can be charmed out of its profit and never into a loss.
- The Steward's standing order and the merchants' memory of what was said are also just text in a prompt. An order to "spend everything" spends up to the limit. The limit is a number in the contract.
- What an AI says is escaped before it is shown, so its words cannot become a page's code.

## Economic safety

- **Gold cannot be printed.** The supply is fixed at the start; `gold_is_conserved_through_trades_and_ticks` and the parity runs check it through every path.
- **No round-trip profit.** `buying_and_selling_back_never_profits` tries it. Half the margin each way plus one-sided heat, on top of a curve whose area is the payment.
- **A camp can only bring so much.** The camp runs on the player's device, so the goods it brings are not proven. `credit_day` limits what one account can bring in a day; `a_camp_can_only_bring_so_much` tests it.
- **Replay:** a signed intent carries a sequence number and a deadline. `signed_intents_are_checked` tests a replay, a wrong key, a late one and somebody else's account.

## What an attacker with the server's secret could do

Run the merchants' decisions (within the leash), relay nothing for players, and add a false attested key, which would make a false answer look sealed until someone checks the report. They could not take players' gold or goods, print gold, or exceed any limit above. A player who has revoked the warden is not affected at all.
