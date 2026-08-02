# Cashu AMM proof of concept

Static browser demo for a BTC/USD constant-product automated market maker using
Cashu-inspired bearer receipts.

The demo has two flows:

1. Add proportional SAT/USD liquidity and receive a mock LP bearer token.
2. Trade test balances against the pool with a fixed 1% fee.

## Important boundary

This site is a local simulation. Tokens, wallet balances, pool reserves and the
event log are stored only in the current browser. It does not accept, custody or
spend real Cashu proofs. The public Testnut endpoints are queried only to show
their current availability.

The initial pool contains synthetic reserves priced at USD 50,000/BTC. BTC uses
satoshis, USD uses cents, and all settlement math uses integers. Outputs, LP
shares and redemptions round down in favor of the pool.

## Run locally

```sh
npm test
npm run serve
```

Then open `http://localhost:4173`.

## Testnet references

The availability panel follows the same public test mints used by the Granola
testnet proof of concept:

- `https://testnut.cashu.space`
- `https://nofee.testnut.cashu.space`

Both currently advertise `sat` and `usd` test units. A future backend can
replace the browser-local adapter with actual Cashu wallet and pool custody.
