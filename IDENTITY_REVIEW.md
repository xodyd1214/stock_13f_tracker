# Security identity review

The quote symbol is not a position identifier. A common issuer name, an inherited
ticker, or an unreviewed CUSIP mapping must not attach an equity quote to a fund,
a debt instrument, a different share class, or another company.

## Behavior

- `market_symbols.json` is the reviewed identity registry. Each reviewed CUSIP
  has its source URL. `ticker_map.json` is only a compatibility mirror.
- Unknown and quarantined CUSIPs remain visible as distinct CUSIP positions.
  Their reported shares, value, and portfolio weight remain available, but no
  current quote is attached. Missing CUSIPs remain separate source rows.
- Manager, total, favorites, consensus, and holder-modal grouping use CUSIP plus
  share/principal and option type, never the quote symbol. Aggregate holdings
  retain their reporting-date range.
- The collector and price fetcher use the same reviewed resolver. Options and
  principal cannot inherit an ordinary share quote.
- `BRK-A`/`BRK.A` and `BRK-B`/`BRK.B` punctuation is canonicalized within each
  class. Class A and Class B are never combined.
- Lifecycle and quote freshness remain separate checks. JHG's historical
  identity is preserved, while its delisted status forbids a current quote.

## Verified corrections

Nine SPDR sector identifiers were shifted to the wrong fund. They now resolve
as follows: 81369Y209 XLV, 81369Y308 XLP, 81369Y407 XLY, 81369Y506 XLE,
81369Y605 XLF, 81369Y704 XLI, 81369Y803 XLK, 81369Y852 XLC, 81369Y860 XLRE.
The missing 81369Y100 XLB mapping was added; 81369Y886 XLU was verified.

Other corrected identities are G02602103 DOX, 133131102 CPT, 133034108 CAC,
40049J206 TV, 479167108 JOUT, 084670108 BRK.A, 09259E108 TCPC,
381430529 GBIL, 64124P101 NBH, and 09290C780 BAI. AMD's correct 007903107
identifier was added. The registry contains the evidence for every mapping,
including the original core collector identities checked during this review.
Additional checks corrected 464286772 from EEM to EWY and 464287234 from EFA
to EEM. The current registry has 59 reviewed identities; the remaining legacy
entries are quarantined, including the retired BlackRock 09247X101 identity.

## Limits and preservation

This is a fail-closed repair, not a claim that every security has been mapped.
Unreviewed legacy rows are quarantined rather than guessed. Restore one only
with exact security-level evidence and any applicable corporate-action review.
Historical identity evidence alone does not establish that a quote is current
or that its per-share basis can be compared with a filing.

No SEC history, holdings snapshot, or existing quote cache was rewritten by
this change. There is no nonempty holdings dataset in this checkout, so the
number/value of deployed positions affected cannot be measured locally.

## Verification

Run `python3 -m unittest discover -s tests -v` with `requests` installed and
`node --test tests/frontend.test.cjs`. Tests cover every reviewed/quarantined
CUSIP, the known mapping errors, non-equity exclusion, colliding quote symbols,
separate share classes, missing identities, and preservation of reported values.
