# Alpha13F partial-display preparation

Prepared locally on November 5, 2026 against GitHub master
6091a3372f3da211de9d05bcaada4ab211b10a72. The initial preparation did not push or deploy. Deployment was explicitly
authorized later on November 5; current deployment status is tracked in GitHub. This is a fresh reconstruction after the earlier local candidate
and source archive were lost, not a recovered copy of those artifacts.

## Approved scope and current evidence

The display covers 43 of the original 50 tracked labels, representing 42 unique
legal SEC reporting entities. Markel and Tom Gayner are two labels for one
reporter and are counted once in financial totals. Names on holdings are legal
reporting-entity names, not assertions that an individual personally selected
each security. The other seven labels remain visible as verification pending,
with null holdings/value fields rather than zero holdings.

Fresh source replay yields 39,753 reported equity rows and $1,548,461,288,506 in
reported equity value. This is a mixed-period partial subset, not total AUM,
current portfolio value, or a market-wide total. Source periods are June 30 and
September 30, 2026. Raw-source checks occurred November 5 between 11:00:23 and
11:22:58 UTC. These figures were recomputed from fresh sources; matching earlier reported totals does not mean the lost candidate survived.

Pending labels:

- Michael Burry, David Tepper, David Einhorn and Paul Singer: the configured
  historical filers do not justify a current portfolio display.
- Li Lu / Himalaya: eight information-table rows sum to $3,702,921,099 versus
  the cover's $3,702,921,098. The one-dollar difference is rounding-consistent,
  but there is no certified exception and no silent tolerance.
- Stanley Druckenmiller / Duquesne: 95 rows sum to 5,210,856 versus the cover's
  5,210,860; same-period peers also raise a roughly 1,000-fold unit concern.
- Seth Klarman / Baupost: 23 rows and the cover agree at 5,415,853, but fresh
  peer comparisons raise a roughly 1,000-fold unit concern. Three peer matches
  were freshly re-established; the older claim of 19 was not re-established.

No automatic multiplier is applied to repair either anomaly. None of these
seven can automatically enter the available group merely because a parser
accepts a later source. Changing scope requires identity/source review.

## Source and transport gates

The acquisition reads every SEC submissions archive descriptor, validates exact
filing counts and enclosing date bounds, and includes all known accessions for
the latest report period, not merely the latest filing date. Final distinct
copies of root metadata and archives must be byte-identical after financial
retrieval. Earlier failed acquisition attempts and their raw files remain in a
separate, explicitly accounted history; none are silently discarded.

The parser preserves raw value strings, date, units, accession, CIK, option and
SH/PRN fields. It reconciles exact cover count/value totals. Filing-date unit
rules are explicit. Full restatements replace earlier tables; additions append
only with complete, ordered, nonduplicated chains. Ambiguous chains fail closed.
Options, warrants and principal-amount positions remain in audit history but
are not silently treated as equity. Bond-fund SH rows remain eligible. Exact
reviewed CUSIP/issuer/class identities preserve QQQE and WEEL fund shares whose
class names contain WT or OPTION. Issuer fact-sheet hashes and URLs are pinned
in the display policy; they are reviewed evidence, not freshly downloaded by
the runtime. Actual Put/Call and PRN fields always win. The four restored fund
share rows total $2,080,306. Every resolved row is accounted for in a count/value
partition; an unresolved class blocks availability instead of silently dropping
a holding. The two true WARRANT rows remain excluded.

Every build replays raw evidence before export and consumes the replayed object,
not mutable files reread after verification. The public projection uses a
lossless grouped-row codec and hash-pinned files. It includes source references,
raw-value provenance, the exact coverage ledger and the display policy. It
does not include the legacy holdings JSON/CSV or the approximately 533 MB full
audit history. The current projection is about 12.6 MiB uncompressed, below its
16 MiB hard limit but above the 8 MiB performance target. Browser performance
has not been measured.

The browser pins one content-addressed generation, checks policy before and
after loading, validates hashes, bytes, source bindings and financial totals,
and never falls back to old holdings. The generation may remain visible as a
clearly dated historical partial snapshot when old. The oldest source check
controls the 24-hour freshness limit. The display does not infer cost basis,
quarter-over-quarter action, split-adjusted return or absent positions.

## Build and verify locally

Use Python 3.10+ and Node 20+. The existing offline tests require requests.

    python -m unittest discover -s tests -v
    node --check app.js
    node --check sec_display_loader.js
    node --test tests/*.test.cjs

Given retained source evidence and the exact identity ledger/request:

    python prepare_partial_release.py EVIDENCE_MANIFEST IDENTITY_LEDGER REQUEST REPO_SOURCE NEW_LOCAL_OUTPUT

This creates a new directory containing audit/, public/ and a build receipt.
It performs no network request, push, workflow dispatch or deployment. A failed
gate removes its temporary output. Existing destinations are never overwritten.
The public/ directory alone is a candidate static Pages artifact. Do not upload
audit/, source archives or the whole repository as the Pages artifact.

For moved archives, verify_candidate supports an explicit three-path
inputs_override mapping for evidenceManifest, ledgerPath and requestPath.
Their exact saved hashes remain mandatory; only path strings are normalized.

## Publication and rollback plan, not permission to publish

1. Recheck the remote HEAD and the live source date before publication. Re-run
   all tests against final files and rebuild from fresh evidence if the oldest
   check exceeds 24 hours or a filing deadline has advanced.
2. Complete the required localhost visual acceptance. It has not run: a prior
   browser launch was denied. This preparation does not retry or bypass that
   restriction, and static/Node checks do not replace visual acceptance.
3. Obtain explicit approval for the exact publication and target. Current
   authorization covers preparation only. Confirm the actual GitHub Pages
   publication mode and workflow before choosing a root-branch or artifact
   deployment. Merely pushing app.js without its generated config/data would
   produce an unavailable view, so do not deploy the code-only patch.
4. Publish the entire verified public/ tree as one reviewed release. Keep the
   generation directory immutable. A pointer is only meaningful together with
   matching config, policy and complete hashed files. GitHub Pages CDN updates
   are not asserted to be atomic; mixed or missing assets must fail closed.
   cache:no-store is a client request, not proof of instantaneous revocation
   across static caches. Verify the deployed generation and all hashes after
   approval and publication before reporting success.
5. Retain the complete last known good v3 release and its private source proof.
   Rollback is another reviewed full-tree publication to that known generation,
   subject to current policy and source freshness checks. Do not roll back to
   the legacy unverified snapshot. There is no previously deployed verified v3
   generation yet. If no safe rollback exists, leave holdings unavailable until
   the source-backed generation can be restored; do not invent empty portfolios.

The local auto_sync.yml candidate refreshes only validated quotes and macro
data. It cannot run legacy 13F publication or change the partial-generation
pointer. A future recurring SEC workflow needs its own reviewed raw-evidence
retention and full gate execution; no new live schedule is enabled here.

Full releaseEligible and migrationReady remain false. A passing partial-display
gate is not a completed migration of the full manager universe.
