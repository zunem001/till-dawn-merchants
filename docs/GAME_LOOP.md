# The game loop

Till Dawn is a survival game: a camp of people, a fire that must not go out, raiders at night. The Grand Market is where its surplus and its shortages meet other camps and seven merchants who are trying to make a living. The loop is the same with or without a chain. The chain is why it can be trusted and why nobody has to run it.

## Every 30 seconds

- The camp works: people gather wood, stone and food, stores fill up, the fire burns.
- The player gives orders and notices things: the wood store is nearly full, there is no medicine and two people are wounded, night is in three hours.
- On the street: stalls show their prices on chalk boards, merchants call out, a porter carries a deal across the street, the banner has the news.

## Every 5 minutes

- **Sell before the store fills.** A full store wastes whatever more is gathered, so the surplus goes to market. The board says who pays best right now.
- **Buy what the next night needs.** Medicine for the wounded, metal for arms, food when the hunters came back empty.
- **Prices answer you.** Selling 200 wood at once pays worse than selling 50 to each of four stalls, because a merchant's price falls as its stock rises. Sell into a glut and you pay for it; find the stall that is short and it pays well.
- **Talk.** A merchant can be charmed, amused or persuaded out of some of its margin on your next trade. It remembers what you said last time.
- **Or send the Steward.** Your camp's AI agent can do all this for you while you see to the camp, up to a limit you set, under an order you give in your own words.

## Every session

- **Who is doing well, who is close to breaking?** A merchant pays rent every dawn. A bad bet, a raid on the road or a rival undercutting it can empty a till.
- **Become a partner.** Your gold buys a share of a stall, and half the margin on its trades goes out by shares.
- **Rescue a stall.** When a merchant cannot pay the rent the shutters come down. Its goods are worth little behind them, so a rescue buys a big share: about a third of the stall for 60 gold. Wait a day and the richest merchant on the street lends the money instead, and the chance is gone. The merchant remembers who saved it.
- **The world moves.** Plagues, good harvests, wars on the roads: twelve kinds of event change what goods are worth. Merchants read them and bet in their own characters: Odin waits, Rook gambles, Thea never pays what she can avoid.

## Why it stays alive without anyone patching it

- Gold is fixed at 16,415. It moves between tills, purses, the treasury and the partners' pool, and it never appears or vanishes. Rent and tariffs flow to the treasury, caravans and loans flow back.
- A round trip can never profit: a player pays half the margin each way, and heavy one-sided trading adds a "heat" that fades in hours. So there is no money machine to find. The profit in the game is in knowing what is short where.
- If the AI goes silent, merchants follow a rulebook in the contract. If the game's server stops, anyone can crank the clock.

## The numbers, measured

From `node near/sim/week.js --measure`, the same rules run tick for tick on the rulebook alone: a stall breaks about 0.5 times a week with no player camps, 1.35 with 3 camps and 2.25 with 8, and each is lent to or rescued. The treasury stays near 12,000 gold of the 14,000 it starts with. Medicine has peaked at about 5 times its usual price when a plague and a shortage met.

With the real AI thinking every game hour (`near/sim/ai_market.mjs`, three game days, no players): tills dip and recover through the day, no stall broke, prices ranged from 0.16 to 4.4 times usual, and merchants made about 50 deals a day with each other.
