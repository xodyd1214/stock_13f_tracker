const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const NOW = Date.parse('2026-11-05T05:00:00Z');
class TestDate extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } }
const fresh = (price, changePct = 0) => ({ price, changePct, marketTime: NOW / 1000 - 60, currency: 'USD' });
const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');
function extract(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function context(names, extra = {}) {
  const metadata = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '../market_symbols.json'), 'utf8'));
  // Unit fixtures model rows already admitted by the separately tested loader.
  const rows = (extra.RAW_HOLDINGS || []).map((row, i) => ({ legalName: row.guru || 'Manager', cik: '0000000001', shareType: 'SH', putCall: '', shares: 1, period: '2026-06-30', filingDate: '2026-08-01', accession: '0000000001-26-000001', sourceRowId: `fixture:${i}`, tableSha256: 'a'.repeat(64), sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/table.xml', ...row }));
  const ctx = vm.createContext({ URL, console, Date: TestDate, MARKET_SYMBOLS: metadata, LIVE_PRICES: {}, SEC_DISPLAY: {rows}, SEC_DISPLAY_ROWS: new WeakSet(rows), document: {getElementById:()=>null}, ...extra, ...(extra.RAW_HOLDINGS ? {RAW_HOLDINGS: rows} : {}) });
  for (const name of new Set(['safeSecUrl', 'escapeHtml', 'verifiedDisplayRow', 'showUnavailableHoldings', 'canonicalTicker', 'hasPrice', 'priceLabel', 'quoteStatus', 'quoteFreshness', 'quoteFields', 'holdingIdentity', 'mergeObservedPrices', 'refreshVisibleQuotes', 'applyLivePricesToHoldings', 'priceComparisonReason', ...names])) vm.runInContext(extract(name), ctx);
  return ctx;
}
const helpers = ['hasPrice', 'priceLabel', 'priceDifference', 'insiderCode', 'insiderLabel', 'quoteFreshness'];
test('congress ticker summaries count unique reporters per direction across 30 filing dates', () => {
  const c = context(['summarizeCongressTickers', 'congressFilingLag']);
  const stock = { ticker: 'NVDA', action: 'P', assetType: 'ST', status: 'New' };
  const filing = (filed, name, district, rows) => ({ kind: 'ptr', filed, name, district, rows });
  const snapshot = [
    filing('2026-10-08', 'Outside window', 'FL01', [stock]),
    filing('2026-10-09', 'First reporter', 'NJ05', [stock, stock, { ...stock, action: 'S (partial)' }]),
    filing('2026-10-13', 'FIRST REPORTER', 'NJ05', [stock, { ...stock, action: 'S' }]),
    filing('2026-11-07', 'Second reporter', 'FL27', [
      { ...stock, action: 'S' }, { ...stock, ticker: 'NVDA', assetType: 'OP' },
      { ...stock, status: 'Amended' }, { ...stock, status: 'Deleted' }, { ...stock, action: 'E' },
      { ...stock, ticker: '' }, { ...stock, ticker: 'AMAT' }
    ]),
    filing('2026-11-08', 'Future filing', 'PA01', [stock]),
  ];
  const result = c.summarizeCongressTickers(snapshot, '2026-11-07');
  assert.equal(result.from, '2026-10-09');
  assert.deepEqual(Array.from(result.tickers, ({ ticker, buy, sell }) => [ticker, buy, sell]),
    [['NVDA', 1, 2], ['AMAT', 1, 0]]);
  assert.equal(c.congressFilingLag('2026-10-23', '2026-11-05'), 13);
  assert.equal(c.congressFilingLag('2026-11-05', '2026-11-05'), 0);
  assert.equal(c.congressFilingLag('2026-11-06', '2026-11-05'), null);
});

test('watchlist 13F uses reviewed security identities and keeps each reported period', () => {
  const c = context(['watchInstitutionHoldings', 'watchSymbol', 'getMappedTicker'], {RAW_HOLDINGS: [
    { guru: 'Earlier manager', cusip: '594918104', value: 100, shares: 10 },
    { guru: 'Earlier manager', cusip: '594918104', value: 20, shares: 2 },
    { guru: 'Latest manager', cusip: '594918104', value: 100, shares: 1, period: '2026-09-30', filingDate: '2026-10-30' },
    { guru: 'Inherited ticker only', ticker: 'MSFT', cusip: '123456789', value: 100 },
    { guru: 'Option position', cusip: '594918104', putCall: 'CALL', value: 100 },
    { guru: 'Unrelated holding', cusip: '037833100', value: 100 }
  ]});
  assert.deepEqual(Array.from(c.watchInstitutionHoldings(c.RAW_HOLDINGS, 'MSFT'), row => [row.legalName, row.shares, row.value]),
    [['Latest manager', 1, 100], ['Earlier manager', 12, 120]]);
});

test('watchlist House activity includes only matched stock purchases in the filing window', () => {
  const c = context(['watchHousePurchases', 'watchSymbol']);
  const trade = { ticker: 'BRK.B', action: 'P', assetType: 'ST', status: 'New', traded: '2026-10-01' };
  const filing = (filed, rows, kind = 'ptr') => ({ filed, rows, kind });
  const snapshot = { asOf: '2026-11-07', ptrFrom: '2026-08-10', filings: [
    filing('2026-10-08', [trade]),
    filing('2026-10-09', [trade, { ...trade, ticker: 'BRK.A' }, { ...trade, action: 'S' },
      { ...trade, status: 'Deleted' }, { ...trade, assetType: 'OP' }, { ...trade, ticker: '' }]),
    filing('2026-11-01', [{ ...trade, status: 'Amended' }]),
    filing('2026-11-05', [trade], 'annual'),
    filing('2026-11-08', [trade])
  ] };
  const result = c.watchHousePurchases(snapshot, 'BRK-B');
  assert.equal(result.start, '2026-10-09');
  assert.deepEqual(Array.from(result.entries, ({ filing, row }) => [filing.filed, row.status]),
    [['2026-11-01', 'Amended'], ['2026-10-09', 'New']]);
});

test('Form 4 watchlist import resolves stored CIKs and legacy tickers without guessing ambiguous issuers', () => {
  const c = context(['resolveForm4Favorites', 'watchSymbol'], {WATCH_KEY: /^\d{10}:[A-Z0-9]{1,10}(?:[.-][A-Z0-9]{1,10})?$/});
  const listings = new Map([
    ['0000000001', 'ABC'], ['0000000001', 'ABC-PB'], ['0000000002', 'XYZ-B'],
    ['0000000003', 'OLD'], ['0000000004', 'DUPE'], ['0000000006', 'MULT-A'], ['0000000006', 'MULT-B']
  ].map(([issuer, ticker]) => {
    const key = `${issuer}:${ticker}`;
    return [key, {issuer, ticker, key}];
  }));
  const result = c.resolveForm4Favorites(['0000000001', 'XYZ.B', 'OLD', 'DUPE', '0000000006', 'MISSING'], listings, [
    {issuerCik: '0000000001', ticker: 'ABC-PB', securityTitle: 'Preferred Stock'},
    {issuerCik: '0000000001', ticker: 'ABC', securityTitle: 'Class A Common Stock'},
    {issuerCik: '0000000002', ticker: 'XYZ.B'},
    {issuerCik: '0000000005', ticker: 'OLD'},
    {issuerCik: '0000000004', ticker: 'DUPE'}, {issuerCik: '0000000005', ticker: 'DUPE'}
  ]);
  assert.deepEqual(Array.from(result, ([issuer, key]) => [issuer, key]), [
    ['0000000001', '0000000001:ABC'], ['0000000002', '0000000002:XYZ-B'], ['0000000005', '0000000005:OLD']
  ]);
});

test('Form 4 watchlist import preserves existing choices and remembers removals across devices', () => {
  const c = context(['planForm4WatchImport'], {WATCH_LIMIT: 2});
  const resolved = new Map([['1', '1:AAA'], ['2', '2:BBB'], ['3', '3:CCC']]);
  const initial = {watchCompanies: ['1:AAAB'], favorites: ['Existing manager']};
  const plan = c.planForm4WatchImport(initial, resolved);
  assert.deepEqual(Array.from(plan.keys), ['1:AAAB', '2:BBB']);
  assert.deepEqual(Array.from(plan.imported), ['1', '2']);
  assert.equal(plan.added, 1);
  assert.equal(plan.remaining, 1);
  assert.deepEqual(initial.watchCompanies, ['1:AAAB']);
  const next = c.planForm4WatchImport({watchCompanies: ['1:AAAB'], form4ImportedIssuers: plan.imported}, resolved);
  assert.deepEqual(Array.from(next.keys), ['1:AAAB', '3:CCC']);
  assert.deepEqual(Array.from(next.imported), ['1', '2', '3']);
});

test('Form 4 and the watchlist share issuer favorites while preserving signed-out local choices', () => {
  const keys = ['0000000001:AAA', '0000000001:AAB', '0000000002:BBB'];
  const state = {f4FavCompanies: ['0000000003']};
  const watchlist = {keys, pending: null};
  const c = context(['applyWatchPreference', 'effectiveWatchKeys', 'form4FavoriteIssuers'], {state, watchlist, CURRENT_USER: {uid: 'owner'}});
  assert.deepEqual(Array.from(c.form4FavoriteIssuers()), ['0000000001', '0000000002']);
  assert.equal(c.applyWatchPreference(keys, {issuer: '0000000001', key: '0000000001:AAC', add: true}), keys);
  watchlist.pending = {issuer: '0000000001', add: false};
  assert.deepEqual(Array.from(c.effectiveWatchKeys()), ['0000000002:BBB']);
  assert.deepEqual(Array.from(c.form4FavoriteIssuers()), ['0000000002']);
  assert.equal(keys.length, 3);
  watchlist.pending = {issuer: '0000000004', key: '0000000004:', add: true};
  assert.deepEqual(Array.from(c.effectiveWatchKeys()), [...keys, '0000000004:']);
  c.CURRENT_USER = null;
  assert.deepEqual(Array.from(c.form4FavoriteIssuers()), ['0000000003']);
});

test('delisted JHG retains history but has no current quote, daily change or discount', () => {
  const observed = { price: 51.95, changePct: -0.04, marketTime: 1782849603 };
  const c = context([...helpers, 'applyLivePricesToHoldings'], { LIVE_PRICES: { JHG: observed } });
  const holdings = [{ ticker: 'JHG', estPrice: 60 }];
  c.applyLivePricesToHoldings(holdings);
  assert.equal(holdings[0].curPrice, null);
  assert.equal(holdings[0].priceChangePct, null);
  assert.ok(Number.isNaN(c.priceDifference(holdings[0])));
  assert.match(holdings[0].quoteAsOf, /상장폐지.*2026-06-30.*마지막 관측.*51\.95.*2026-06-30 20:00/);
  assert.equal(c.LIVE_PRICES.JHG, observed);
});
test('missing lifecycle metadata fails closed rather than showing a retired quote', () => {
  const c = context(helpers, { MARKET_SYMBOLS: null });
  const quote = c.quoteFields('JHG', { price: 51.95, changePct: 0 });
  assert.equal(quote.curPrice, null);
  assert.equal(quote.priceChangePct, null);
  assert.match(quote.quoteAsOf, /거래 상태 확인 불가/);
});
test('exact CUSIP identity takes precedence over obsolete SQ and bond aliases', () => {
  const map = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '../ticker_map.json'), 'utf8'));
  const c = context(['getMappedTicker'], { TICKER_MAP: map });
  for (const [cusip, expected] of [['852234103', 'XYZ'], ['093671105', 'HRB'], ['G17429104', 'BGIN'], ['69702V107', 'PSBD'], ['892231101', 'TSQ']]) {
    assert.equal(c.getMappedTicker('Block', 'SQ', cusip), expected);
  }
  assert.equal(c.getMappedTicker('Block note', 'SQ', '852234AK9'), 'CUSIP:852234AK9');
  assert.equal(c.getMappedTicker('Block', 'SQ', ''), 'UNMAPPED:Block');
  assert.equal(c.getMappedTicker('Intellicheck', 'IDN', '45817G201'), 'CUSIP:45817G201');
  assert.equal(c.getMappedTicker('Intelligent Protection', 'IPM', '69764K106'), 'CUSIP:69764K106');
});
test('legacy SQ holdings use XYZ quote without reviving old SQ cache', () => {
  const c = context([...helpers, 'applyLivePricesToHoldings'], { LIVE_PRICES: { SQ: { price: 999 }, XYZ: fresh(87.63) } });
  const holdings = [{ ticker: 'SQ', estPrice: 100 }];
  c.applyLivePricesToHoldings(holdings);
  assert.equal(holdings[0].curPrice, 87.63);
  delete c.LIVE_PRICES.XYZ;
  c.applyLivePricesToHoldings(holdings);
  assert.equal(holdings[0].curPrice, null);
});
test('initial manager and aggregate JHG holdings stay historical-only', () => {
  const c = context([...helpers, 'getMappedTicker', 'formatMoney', 'formatQuarterDisplay', 'processAndRenderHoldingsData'], {
    RAW_HOLDINGS: [{ guru: 'Manager', name: 'Janus Henderson', cusip: 'G4474Y214', shares: 10, value: 600, period: '2026-06-30', action: 'HOLD' }],
    GURU_DATABASE: {}, LIVE_PRICES: { JHG: { price: 51.95, marketTime: 1782849603 } }, TICKER_MAP: { G4474Y214: 'JHG' }, DOMINANT_13F_PERIOD: null,
    isDerivativeOrOption: () => false, getMappedSector: () => 'Financials', renderCategoryTabs() {}, renderGuruSidebar() {}, selectGuru() {}, renderConsensusWidget() {}
  });
  c.processAndRenderHoldingsData();
  for (const key of ['Manager', '__GRAND_TOTAL__']) {
    const h = c.GURU_DATABASE[key].holdings[0];
    assert.equal(h.ticker, 'JHG');
    assert.equal(h.rawShares, 10);
    assert.equal(h.value, 600);
    assert.equal(h.estPrice, null);
    assert.equal(h.curPrice, null);
    assert.match(h.quoteAsOf, /상장폐지/);
    assert.ok(Number.isNaN(c.priceDifference(h)));
  }
});
test('consensus card renders delisted quote as history, never as current or daily change', () => {
  const grid = { innerHTML: '' };
  const c = context([...helpers, 'getMappedTicker', 'formatMoney', 'renderConsensusWidget'], {
    RAW_HOLDINGS: [{ guru: 'Manager', name: 'Janus Henderson', cusip: 'G4474Y214', ticker: 'JHG', value: 100 }],
    TICKER_MAP: {}, LIVE_PRICES: { JHG: { price: 51.95, changePct: -0.04, marketTime: 1782849603 } }, CURRENT_CONSENSUS_TYPE: 'HOLDERS',
    document: { getElementById: () => grid }, isDerivativeOrOption: () => false, getMappedSector: () => 'Financials'
  });
  c.renderConsensusWidget();
  assert.match(grid.innerHTML, /class="consensus-price">시세 없음/);
  assert.match(grid.innerHTML, /상장폐지.*마지막 관측.*51\.95/);
  assert.doesNotMatch(grid.innerHTML, /-0\.04%/);
});
test('quarantine cannot fall back to raw XYZ, issuer name or an old quote cache', () => {
  const c = context([...helpers, 'getMappedTicker'], { TICKER_MAP: { 'BLOCK INC': 'XYZ' } });
  const cusips = ['71531U102', '55825T103', '558256103', '36468G103', '69181V107', '71531T105'];
  for (const id of cusips) {
    for (const raw of ['XYZ', 'SQ', '']) assert.equal(c.getMappedTicker('BLOCK INC', raw, id), `CUSIP:${id}`);
    assert.equal(c.quoteFields(`CUSIP:${id}`, { price: 87.63 }).curPrice, null);
  }
});
test('minute polling retries missing metadata and restores quotes without resetting manager', async () => {
  const metadata = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '../market_symbols.json'), 'utf8'));
  let attempts = 0;
  let rebuilds = 0;
  const c = context([...helpers, 'refreshMarketSymbols', 'fetchLivePricesForCurrentView', 'applyLivePricesToHoldings'], {
    MARKET_SYMBOLS: null, priceRequestId: 0, state: { currentGuruKey: 'A', currentFilingType: '13F' },
    GURU_DATABASE: { A: { holdings: [{ ticker: 'AAPL', estPrice: 100 }] } }, LIVE_PRICES: { AAPL: fresh(90) },
    fetch: async url => url.startsWith('market_symbols') ? (++attempts === 1 ? { ok: false } : { ok: true, json: async () => metadata }) : { ok: true, json: async () => ({}) },
    processAndRenderHoldingsData(preserveView) { assert.equal(preserveView, true); rebuilds++; },
    updateSummaryMetrics() {}, renderTable() {}, refreshMacroSnapshot: async () => {}
  });
  await c.fetchLivePricesForCurrentView();
  assert.equal(c.GURU_DATABASE.A.holdings[0].curPrice, null);
  await c.fetchLivePricesForCurrentView();
  assert.equal(attempts, 2);
  assert.equal(rebuilds, 1);
  assert.equal(c.state.currentGuruKey, 'A');
  assert.equal(c.GURU_DATABASE.A.holdings[0].curPrice, 90);
});
test('late lifecycle metadata response cannot override a newer request', async () => {
  let release;
  const c = context(['refreshMarketSymbols'], { MARKET_SYMBOLS: null, priceRequestId: 1, fetch: () => new Promise(resolve => { release=resolve; }) });
  const pending = c.refreshMarketSymbols(1);
  c.priceRequestId=2;
  release({ok:true,json:async()=>({aliases:{},inactive:{},reviewedCusips:{},nonEquityCusips:{},quarantinedCusips:{}})});
  assert.equal(await pending,false);
  assert.equal(c.MARKET_SYMBOLS,null);
});
test('metadata recovery rebuilds real portfolios without replacing another mode or resetting custom view', () => {
  for (const mode of ['13F', 'MACRO', 'FORM4', '13D']) {
    for (const manager of ['Manager', '__CUSTOM_GROUP__']) {
      let renders = 0;
      const c = context([...helpers, 'getMappedTicker', 'formatMoney', 'formatQuarterDisplay', 'processAndRenderHoldingsData', 'buildCustomGroupPortfolio'], {
        RAW_HOLDINGS: [{ guru: 'Manager', name: 'Janus Henderson', cusip: 'G4474Y214', shares: 10, value: 600, period: '2026-06-30', action: 'HOLD' }],
        GURU_DATABASE: {}, LIVE_PRICES: { JHG: { price: 51.95, marketTime: 1782849603 } }, TICKER_MAP: { G4474Y214: 'JHG' }, DOMINANT_13F_PERIOD: null,
        state: { currentGuruKey: manager, currentFilingType: mode, activeFilter: 'DISCOUNT', searchQuery: 'Janus' },
        isDerivativeOrOption: () => false, getMappedSector: () => 'Financials', getFavorites: () => ['Manager'], renderCategoryTabs() {}, renderGuruSidebar() {},
        selectGuru() { throw new Error('Recovery must not reset selection or start a recursive refresh'); }, loadGuruData() { renders++; }, renderConsensusWidget() {}
      });
      c.processAndRenderHoldingsData(true);
      assert.equal(c.GURU_DATABASE[manager].holdings[0].curPrice, null);
      assert.equal(c.state.currentGuruKey, manager);
      assert.equal(c.state.currentFilingType, mode);
      assert.equal(c.state.activeFilter, 'DISCOUNT');
      assert.equal(c.state.searchQuery, 'Janus');
      assert.equal(renders, mode === '13F' ? 1 : 0);
    }
  }
});
test('missing price is not a zero-percent live quote or discount', () => {
  const c = context([...helpers, 'applyLivePricesToHoldings'], { LIVE_PRICES: {} });
  const holdings = [{ ticker: 'AAPL', estPrice: 100, curPrice: 100 }];
  c.applyLivePricesToHoldings(holdings);
  assert.equal(holdings[0].curPrice, null);
  assert.equal(holdings[0].priceChangePct, null);
  assert.ok(Number.isNaN(c.priceDifference(holdings[0])));
  assert.equal(c.priceLabel(null), '시세 없음');
  c.LIVE_PRICES.AAPL = fresh(90);
  c.applyLivePricesToHoldings(holdings);
  assert.ok(Number.isNaN(c.priceDifference(holdings[0])));
  assert.match(c.priceComparisonReason(holdings[0]), /주식분할.*비교 보류/);
  assert.equal(holdings[0].priceChangePct, 0);
});
test('unmapped securities do not collide via issuer prefix and class ticker survives', () => {
  const c = context(['getMappedTicker'], { TICKER_MAP: { '037833100': 'AAPL' } });
  assert.notEqual(c.getMappedTicker('ISHARES FUND A', '', '111111111'), c.getMappedTicker('ISHARES FUND B', '', '222222222'));
  assert.equal(c.getMappedTicker('Berkshire', 'BRK-B', '084670702'), 'BRK.B');
  assert.equal(c.getMappedTicker('Apple', '', '037833100'), 'AAPL');
  assert.ok(c.getMappedTicker('Unknown issuer', '', '').startsWith('UNMAPPED:'));
});
test('insider canonical codes distinguish buys, sales, awards, exercises and unknowns', () => {
  const c = context(helpers);
  assert.equal(c.insiderLabel({ txTypeCode: 'P' }), '매수 (P)');
  for (const code of ['A', 'M', 'G', 'F', 'Z']) assert.notEqual(c.insiderLabel({ txTypeCode: code }), '매도 (S)');
  assert.equal(c.insiderCode({ txTypeCode: 'A', transactionCode: 'P' }), 'A');
});
test('Form 4 rejects legacy rows and resolves the issuer independently of the reporter', () => {
  const snapshot = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '../latest_form4_insiders.json'), 'utf8'));
  const c = context(['validateForm4Snapshot', 'form4IssuerForTicker', 'form4Price', 'form4Security', 'recentDirectPurchases', 'form4DirectFrom', 'getF4ScopeDataset', 'getF4ActiveDataset'], {
    FORM4_DATA: snapshot.transactions, recentForm4Snapshot: null, state: { selectedF4Issuer: '0000070858', f4Filter: 'ALL' }
  });
  assert.equal(c.validateForm4Snapshot(snapshot), true);
  assert.equal(c.validateForm4Snapshot([{ ticker: 'BAC', price: 6.334 }]), false);
  assert.equal(c.form4IssuerForTicker(snapshot.transactions, 'PNI'), '0001170311');
  assert.equal(c.form4IssuerForTicker(snapshot.transactions, 'BRK-B'), '0001067983');
  const pni = snapshot.transactions.find(row => row.ticker === 'PNI' && row.shares === 12170);
  assert.match(pni.insiderName, /BANK OF AMERICA.*MERRILL LYNCH/);
  assert.equal(c.form4Price(pni.price), '$6.334');
  assert.equal(c.form4Price(null), '미기재');
  assert.match(c.form4Security({ securityTitle: 'Common Stock, $0.001 par value' }), />보통주<\/span>$/);
  assert.equal(c.form4Security({ securityTitle: 'Class B Common Stock' }), 'Class B Common Stock');
  assert.ok(c.getF4ActiveDataset().every(row => row.ticker === 'BAC'));
  assert.ok(c.getF4ActiveDataset().length > 0);
  c.state.f4Filter = 'DIRECT';
  assert.equal(c.getF4ActiveDataset().length, 0);
  c.state.selectedF4Issuer = null;
  assert.equal(c.getF4ActiveDataset().length, snapshot.transactions.filter(row => row.directInsiderPurchase === true).length);
  assert.ok(c.getF4ActiveDataset().every(row => row.ownership === 'D' && row.txTypeCode === 'P'));
  assert.ok(!c.getF4ActiveDataset().some(row => row.ticker === 'TSM'));
});
test('Form 4 direct purchase period uses the latest verified filing day', () => {
  const transactions = ['2026-11-06', '2026-10-31', '2026-10-30', '2026-10-26']
    .map(filingDate => ({ filingDate, directInsiderPurchase: true }));
  const c = context(['recentDirectPurchases', 'form4DirectFrom', 'getF4ScopeDataset'], {
    FORM4_DATA: [], recentForm4Snapshot: { transactions, coverage: { from: '2026-10-24', through: '2026-11-06' } },
    state: { f4Filter: 'DIRECT', f4Period: 'all' },
  });
  assert.equal(c.getF4ScopeDataset(), transactions);
  c.state.f4Period = 'week';
  assert.equal(c.form4DirectFrom(), '2026-10-31');
  assert.deepEqual(c.getF4ScopeDataset(), transactions.slice(0, 2));
});
test('history displays an honest unavailable state, never synthesized quarters', () => {
  const children = [];
  const c = context(['renderStockHistoryTimeline'], { document: { getElementById: () => ({ appendChild: el => children.push(el) }), createElement: () => ({}) } });
  c.renderStockHistoryTimeline({ weight: 5 });
  assert.equal(children.length, 1);
  assert.match(children[0].textContent, /데이터가 없어/);
});
test('custom common holdings are UNKNOWN and inferred cost is unavailable', () => {
  const h = { ticker: 'ABC', baseTicker: 'ABC', cusip: '111111111', rawShares: 10, value: 100, estPrice: 10, curPrice: null };
  const c = context(['formatMoney', 'formatQuarterDisplay', 'buildCustomGroupPortfolio'], { getFavorites: () => ['A', 'B'], selectGuru() {}, DOMINANT_13F_PERIOD: null, GURU_DATABASE: { A: { name: 'A', holdings: [h] }, B: { name: 'B', holdings: [{ ...h, rawShares: 20, value: 300, estPrice: 15 }] } } });
  c.buildCustomGroupPortfolio();
  const result = c.GURU_DATABASE.__CUSTOM_GROUP__.holdings[0];
  assert.equal(result.holders, 2);
  assert.equal(result.action, 'UNKNOWN');
  assert.equal(result.estPrice, null);
});
test('summary clears stale picks before empty/new manager render', () => {
  const elements = {};
  const c = context([...helpers, 'updateSummaryMetrics'], { state: { currentGuruKey: 'A' }, document: { getElementById: id => elements[id] ||= { innerText: 'OLD' } } });
  c.updateSummaryMetrics({ holdings: [], aum: '$0' });
  assert.equal(elements.metricTopBuy.innerText, '-');
  assert.equal(elements.metricDiscountPick.innerText, '-');
  assert.equal(elements.metricTopHolding.innerText, '-');
});
test('late insider response cannot overwrite newer modal', async () => {
  let finish;
  const content = { innerHTML: '' };
  const c = context([...helpers, 'renderModalInsiderCross'], { insiderRequestId: 0, FORM4_DATA: [], document: { getElementById: id => id === 'modalInsiderContent' ? content : { style: {} } }, loadVerifiedForm4: () => new Promise(resolve => { finish = resolve; }) });
  const old = c.renderModalInsiderCross({ ticker: 'OLD' });
  c.insiderRequestId++;
  content.innerHTML = 'NEW MODAL';
  finish([]);
  await old;
  assert.equal(content.innerHTML, 'NEW MODAL');
});
test('late quote response does not redraw the previously selected manager', async () => {
  let finish;
  let renders = 0;
  const c = context(['hasPrice', 'fetchLivePricesForCurrentView'], { refreshMacroSnapshot: async () => {}, priceRequestId: 0, state: { currentGuruKey: 'A', currentFilingType: '13F' }, GURU_DATABASE: { A: { holdings: [{ ticker: 'AAPL' }] }, B: { holdings: [] } }, LIVE_PRICES: {}, MACRO_DATA: null, fetch: () => new Promise(resolve => { finish = resolve; }), applyLivePricesToHoldings() { renders++; }, updateSummaryMetrics() { renders++; }, renderTable() { renders++; } });
  const pending = c.fetchLivePricesForCurrentView();
  c.state.currentGuruKey = 'B';
  finish({ ok: true, json: async () => ({ AAPL: { price: 100 } }) });
  await pending;
  assert.equal(renders, 2);
});
test('macro null observations display unknown instead of fabricated defaults', () => {
  const elements = {};
  const c = context(['macroFreshness', 'upcomingMacroEvents', 'macroHelpButton', 'renderMacroPulseBar', 'renderMacroMarketProxies', 'renderMacroBenchmarks'], { MACRO_DATA: { schemaVersion: 2, benchmarks: { fedRate: { gapToNeutral: null }, inflation: { gapToTarget: null } }, treasury: { spread10Y_13W: { spread: null }, yield10Y: { val: null } }, commoditiesAndFx: { gold: { val: null } } }, document: { getElementById: id => elements[id] ||= {} } });
  c.renderMacroPulseBar();
  c.renderMacroMarketProxies();
  c.renderMacroBenchmarks();
  const html = elements.macroPulseBar.innerHTML + elements.macroMarketProxyGrid.innerHTML;
  assert.match(html, /확인 불가/);
  assert.doesNotMatch(html, /4\.80|3\.77|3\.4|92\.36|4430|null|NaN/);
  assert.equal((html.match(/aria-controls="macroHelp"/g) || []).length, 9);
});
test('invalid treasury observations cannot turn null into zero-yield chart points', () => {
  const c = context(['getFilteredTreasuryData'], { MACRO_DATA: { timeSeries: { treasuryDaily: [{ date: '2026-01-01', y3m: null, y5y: 2, y10y: 3, spread: 1 }, { date: '2026-01-02', y3m: 1, y5y: 2, y10y: 3, spread: 2 }] } } });
  assert.equal(c.getFilteredTreasuryData('1M').length, 1);
});
test('holdings pipeline keeps UNKNOWN actions and does not create missing quotes', () => {
  const c = context([...helpers, 'getMappedTicker', 'formatMoney', 'formatQuarterDisplay', 'processAndRenderHoldingsData'], { RAW_HOLDINGS: [{ guru: 'Manager', name: 'Unmapped Fund A', cusip: '111111111', shares: 10, value: 100, period: '2026-06-30', action: 'UNKNOWN' }, { guru: 'Manager', name: 'Unmapped Fund B', cusip: '222222222', shares: 20, value: 400, period: '2026-06-30', action: 'HOLD' }], GURU_DATABASE: {}, LIVE_PRICES: {}, TICKER_MAP: {}, DOMINANT_13F_PERIOD: null, isDerivativeOrOption: () => false, getMappedSector: () => 'Unknown', renderCategoryTabs() {}, renderGuruSidebar() {}, selectGuru() {}, renderConsensusWidget() {} });
  c.processAndRenderHoldingsData();
  assert.equal(c.GURU_DATABASE.Manager.holdings.length, 2);
  const first = c.GURU_DATABASE.Manager.holdings.find(h => h.cusip === '111111111');
  assert.equal(first.action, 'UNKNOWN');
  assert.equal(first.estPrice, null);
  assert.equal(first.curPrice, null);
  assert.equal(first.priceChangePct, null);
});
test('macro modal closes after opening and repeated open-close cycles', () => {
  const classes = new Set();
  const modal = { classList: { add: name => classes.add(name), remove: (...names) => names.forEach(name => classes.delete(name)) } };
  const body = {};
  const c = context(['macroFreshness', 'openMacroModal', 'closeMacroModal'], { MACRO_DATA: null, document: { getElementById: id => id === 'macroModal' ? modal : body } });
  for (let i = 0; i < 2; i++) {
    c.openMacroModal();
    assert.ok(classes.has('active'));
    c.closeMacroModal();
    assert.equal(classes.size, 0);
  }
  classes.add('show');
  c.closeMacroModal();
  assert.equal(classes.size, 0);
});
test('legacy macro observations and synthetic history are withheld', () => {
  const c = context(['normalizeMacroData', 'macroFreshness']);
  const data = c.normalizeMacroData({ fedRate: { targetRange: '3.5%' }, calendar: [{ name: 'Invented' }], timeSeries: { treasuryDaily: [1, 2] } });
  assert.equal(data.status, 'unavailable');
  assert.equal(data.calendar.length, 0);
  assert.equal(data.timeSeries.treasuryDaily.length, 0);
  assert.match(c.macroFreshness(data), /표시 보류/);
});
test('v2 source age and stale status are visible and genuine zero quote change stays zero', () => {
  const elements = {};
  const data = { schemaVersion: 2, status: 'partial', sources: { gold: { status: 'stale', asOf: '2026-01-01' } }, commoditiesAndFx: { gold: { val: 100, change: 0 } } };
  const c = context(['normalizeMacroData', 'macroFreshness', 'quoteFreshness', 'macroHelpButton', 'renderMacroMarketProxies'], { MACRO_DATA: data, document: { getElementById: id => elements[id] ||= {} } });
  assert.equal(c.normalizeMacroData(data), data);
  assert.match(c.macroFreshness(data), /오래된 관측값 포함/);
  assert.match(c.macroFreshness(data), /2026-01-01/);
  assert.match(c.quoteFreshness({ marketTime: 1 }), /과거 시세/);
  c.renderMacroMarketProxies();
  assert.match(elements.macroMarketProxyGrid.innerHTML, /0\.0%/);
});
test('v2 unavailable summary handles explicit null benchmark gaps', async () => {
  const elements = {};
  const c = context(['loadAndRenderMacro'], { MACRO_DATA: { schemaVersion: 2, status: 'unavailable', benchmarks: { fedRate: { gapToNeutral: null }, inflation: { gapToTarget: null } } }, renderMacroPulseBar() {}, renderMacroBenchmarks() {}, renderMacroCharts() {}, renderMacroMarketProxies() {}, renderMacroCalendar() {}, document: { getElementById: id => elements[id] ||= {} } });
  await c.loadAndRenderMacro();
  assert.doesNotMatch(elements.macroFedSub.innerText + elements.macroCpiSub.innerText, /null|undefined/);
  assert.equal(elements.macroSpreadVal.innerText, '확인 불가');
});
test('late static macro fallback cannot replace a newer snapshot', async () => {
  let release;
  const snapshot = { schemaVersion: 2, status: 'success' };
  const c = context(['hasPrice', 'normalizeMacroData', 'refreshMacroSnapshot', 'fetchLivePricesForCurrentView'], { priceRequestId: 0, state: { currentGuruKey: 'A', currentFilingType: '13F' }, GURU_DATABASE: { A: { holdings: [] } }, LIVE_PRICES: {}, MACRO_DATA: snapshot, fetch: async () => ({ ok: false }), fetchMacroSnapshot: () => new Promise(resolve => { release = resolve; }), updateSummaryMetrics() {}, renderTable() {}, renderMacroPulseBar() { throw new Error('Stale macro render'); } });
  const pending = c.fetchLivePricesForCurrentView();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  c.priceRequestId++;
  release({ schemaVersion: 2, status: 'stale' });
  await pending;
  assert.equal(c.MACRO_DATA, snapshot);
});
test('API and static quote paths both fully redraw refreshed macro snapshots', async () => {
  for (const apiOk of [true, false]) {
    let redraws = 0;
    const next = { schemaVersion: 2, status: 'success', treasury: {} };
    const c = context(['hasPrice', 'normalizeMacroData', 'refreshMacroSnapshot', 'fetchLivePricesForCurrentView'], { priceRequestId: 0, state: { currentGuruKey: 'A', currentFilingType: 'MACRO' }, GURU_DATABASE: { A: { holdings: [] } }, LIVE_PRICES: {}, MACRO_DATA: {}, fetch: async url => url.startsWith('/api/') ? { ok: apiOk, json: async () => ({}) } : { ok: false }, fetchMacroSnapshot: async () => next, loadAndRenderMacro: async () => { redraws++; } });
    await c.fetchLivePricesForCurrentView();
    assert.equal(c.MACRO_DATA, next);
    assert.equal(redraws, 1);
  }
});
test('manager summary identifies older retained filing period without claiming collection failure', () => {
  const c = context(['portfolioFreshness']);
  const older = c.portfolioFreshness({ periodDate: '2026-03-31', filingDate: '2026-05-12', latestDatasetPeriod: '2026-06-30' });
  assert.match(older, /2026-03-31/);
  assert.match(older, /2026-05-12/);
  assert.match(older, /이전 분기 자료/);
  assert.doesNotMatch(c.portfolioFreshness({ periodDate: '2026-06-30', filingDate: '2026-08-12', latestDatasetPeriod: '2026-06-30' }), /이전 분기 자료/);
  assert.match(c.portfolioFreshness({}), /미확인/);
  assert.match(c.portfolioFreshness({ periodRange: ['2026-03-31', '2026-06-30'] }), /서로 다른 분기/);
});


test('stale, undated, invalid-time, unsupported-currency and explicit stale quotes are history only', () => {
  const c = context(helpers);
  const fixtures = [
    { ...fresh(110), marketTime: NOW / 1000 - 86401 },
    { ...fresh(110), marketTime: null },
    { ...fresh(110), marketTime: 0 },
    { ...fresh(110), marketTime: NOW / 1000 + 301 },
    { ...fresh(110), stale: true },
    { ...fresh(110), currency: 'JPY' },
    { ...fresh(110), currency: null }
  ];
  for (const info of fixtures) {
    const q = c.quoteFields('NVDA', info);
    assert.equal(q.curPrice, null);
    assert.equal(q.priceChangePct, null);
    assert.match(q.quoteAsOf, /마지막 관측/);
  }
  const current = c.quoteFields('NVDA', fresh(110, 0));
  assert.equal(current.curPrice, 110);
  assert.equal(current.priceChangePct, 0);
  assert.equal(current.quoteStatus, 'fresh');
  assert.equal(c.quoteStatus({ ...fresh(110), marketTime: NOW / 1000 - 86400 }), 'fresh');
});

test('representative forward/reverse splits never become a discount or upside signal without verified adjustments', () => {
  const c = context(helpers);
  for (const [ticker, filingPrice, quotePrice] of [['NVDA', 1100, 110], ['AVGO', 1700, 170], ['TEST', 2, 20]]) {
    const item = { ticker, estPrice: filingPrice, ...c.quoteFields(ticker, fresh(quotePrice)), periodDate: '2024-03-31' };
    assert.equal(item.curPrice, quotePrice);
    assert.ok(Number.isNaN(c.priceDifference(item)));
    assert.match(c.priceComparisonReason(item), /주식분할.*조정 미확인.*비교 보류/);
  }
  const mixed = { estPrice: 100, ...c.quoteFields('AAPL', fresh(90)), periodRange: ['2026-03-31', '2026-06-30'] };
  assert.match(c.priceComparisonReason(mixed), /서로 다른 분기/);
});

test('cache merge is monotonic by market observation time, never by fetch time', () => {
  const latest = fresh(100);
  const c = context(helpers, { LIVE_PRICES: { AAPL: latest } });
  for (const replacement of [
    { ...fresh(5), marketTime: latest.marketTime - 1, fetchedAt: NOW + 100000 },
    { ...fresh(5), marketTime: null },
    { ...fresh(5), marketTime: NOW / 1000 + 301 },
    { ...fresh(5), marketTime: latest.marketTime },
    { ...fresh(0), marketTime: latest.marketTime + 1 },
    { ...fresh(NaN), marketTime: latest.marketTime + 1 }
  ]) {
    c.mergeObservedPrices({ AAPL: replacement });
    assert.equal(c.LIVE_PRICES.AAPL, latest);
  }
  const next = { ...fresh(101), marketTime: latest.marketTime + 1 };
  c.mergeObservedPrices({ AAPL: next, SQ: fresh(999) });
  assert.equal(c.LIVE_PRICES.AAPL, next);
  assert.equal(c.LIVE_PRICES.XYZ, undefined);
  c.mergeObservedPrices(null);
  c.mergeObservedPrices([]);
  c.LIVE_PRICES.AAPL = { ...fresh(999), marketTime: NOW / 1000 + 100000 };
  c.mergeObservedPrices({ AAPL: next });
  assert.equal(c.LIVE_PRICES.AAPL, next, 'invalid future cache cannot poison valid replacements');
});

test('API and static fallback cannot roll back a more recent cached quote', async () => {
  for (const apiOk of [true, false]) {
    const newest = fresh(100);
    const older = { ...fresh(20), marketTime: newest.marketTime - 3600 };
    const holding = { ticker: 'AAPL', estPrice: 100 };
    const c = context([...helpers, 'fetchLivePricesForCurrentView'], {
      priceRequestId: 0, state: { currentGuruKey: 'A', currentFilingType: '13F' },
      GURU_DATABASE: { A: { holdings: [holding] } }, LIVE_PRICES: { AAPL: newest },
      fetch: async url => ({ ok: url.startsWith('/api/') ? apiOk : true, json: async () => ({ AAPL: older }) }),
      updateSummaryMetrics() {}, renderTable() {}, refreshMacroSnapshot: async () => {}
    });
    await c.fetchLivePricesForCurrentView();
    assert.equal(c.LIVE_PRICES.AAPL, newest);
    assert.equal(holding.curPrice, 100);
  }
});

test('failed refresh still ages selected, other-manager and open-modal prices out of live surfaces', async () => {
  const old = { ...fresh(100), marketTime: NOW / 1000 - 86401 };
  const holding = { ticker: 'AAPL', estPrice: 110, curPrice: 100, priceChangePct: 1 };
  const modalItem = { ...holding };
  let renders = 0;
  let modalRenders = 0;
  const c = context([...helpers, 'fetchLivePricesForCurrentView'], {
    priceRequestId: 0, state: { currentGuruKey: 'A', currentFilingType: '13F' },
    GURU_DATABASE: { A: { holdings: [holding] }, B: { holdings: [{ ...holding }] } },
    LIVE_PRICES: { AAPL: old }, ACTIVE_STOCK_ITEM: modalItem,
    fetch: async () => ({ ok: false }), updateSummaryMetrics() {}, renderTable() { renders++; },
    refreshMacroSnapshot: async () => {}, document: { getElementById: () => ({ classList: { contains: () => true } }) },
    renderStockQuote() { modalRenders++; }
  });
  await c.fetchLivePricesForCurrentView();
  for (const item of [holding, c.GURU_DATABASE.B.holdings[0], modalItem]) {
    assert.equal(item.curPrice, null);
    assert.equal(item.priceChangePct, null);
    assert.match(item.quoteAsOf, /과거 시세/);
  }
  assert.equal(renders, 2);
  assert.equal(modalRenders, 2);
});

test('13F deadlines apply weekend, Presidents Day, daylight time and future-quarter rollover', () => {
  const c = context(['nextFilingDeadline']);
  const cases = [
    ['2026-01-01T00:00:00Z', '2025 Q4', '2026-02-17', '2026-02-17T22:30:00.000Z'],
    ['2026-02-17T22:30:00Z', '2026 Q1', '2026-05-15', '2026-05-15T21:30:00.000Z'],
    ['2026-05-16T00:00:00Z', '2026 Q2', '2026-08-14', '2026-08-14T21:30:00.000Z'],
    ['2026-11-05T00:00:00Z', '2026 Q3', '2026-11-16', '2026-11-16T22:30:00.000Z'],
    ['2026-11-16T22:30:00Z', '2026 Q4', '2027-02-16', '2027-02-16T22:30:00.000Z'],
    ['2028-03-01T00:00:00Z', '2028 Q1', '2028-05-15', '2028-05-15T21:30:00.000Z']
  ];
  for (const [now, quarter, date, instant] of cases) {
    const deadline = c.nextFilingDeadline(Date.parse(now));
    assert.equal(deadline.quarter, quarter);
    assert.equal(deadline.dueDate, date);
    assert.equal(new Date(deadline.deadlineTime).toISOString(), instant);
  }
});

test('unmapped sectors remain Other rather than inflating Technology', () => {
  const c = context(['getMappedSector'], { SECTOR_MAP: { AAPL: 'Technology', 'BRK.B': 'Financials' } });
  assert.equal(c.getMappedSector('UNKNOWN', null), 'Other');
  assert.equal(c.getMappedSector('UNKNOWN', 'General'), 'Other');
  assert.equal(c.getMappedSector('UNKNOWN', 'Healthcare'), 'Healthcare');
  assert.equal(c.getMappedSector('BRK-B', 'Other'), 'Financials');
});

test('every reviewed identity overrides contaminated tickers and every quarantine fails closed', () => {
  const c = context(['getMappedTicker'], { TICKER_MAP: { 'APPLE': 'AAPL', '111111111':'AAPL' } });
  for (const [cusip, record] of Object.entries(c.MARKET_SYMBOLS.reviewedCusips)) {
    for (const raw of ['', cusip, 'SQ', 'INTC']) {
      assert.equal(c.getMappedTicker('Wrong issuer', raw, cusip), record.ticker, `${cusip} with ${raw}`);
    }
    assert.equal(c.getMappedTicker('Equity issuer note', record.ticker, cusip, 'PRN'), `CUSIP:${cusip}`);
    assert.equal(c.getMappedTicker('Equity issuer option', record.ticker, cusip, 'SH', 'CALL'), `CUSIP:${cusip}`);
  }
  for (const cusip of Object.keys(c.MARKET_SYMBOLS.quarantinedCusips)) {
    for (const raw of ['', cusip, 'AAPL']) assert.equal(c.getMappedTicker('APPLE', raw, cusip), `CUSIP:${cusip}`);
  }
  assert.equal(c.getMappedTicker('APPLE', 'AAPL', '111111111'), 'CUSIP:111111111');
  assert.equal(c.getMappedTicker('APPLE', 'AAPL', ''), 'UNMAPPED:APPLE');
  c.MARKET_SYMBOLS = null;
  assert.equal(c.getMappedTicker('APPLE', 'AAPL', '037833100'), 'CUSIP:037833100');
});

test('Berkshire classes are separate securities while punctuation aliases are canonical', () => {
  const c = context(['getMappedTicker']);
  assert.equal(c.getMappedTicker('Berkshire', 'BRK.B', '084670108'), 'BRK.A');
  assert.equal(c.getMappedTicker('Berkshire', 'BRK.A', '084670702'), 'BRK.B');
  assert.equal(c.canonicalTicker('brk-b'), 'BRK.B');
  assert.equal(c.canonicalTicker('brk-a'), 'BRK.A');
  assert.notEqual(c.holdingIdentity({cusip:'084670108'}), c.holdingIdentity({cusip:'084670702'}));
});

test('ticker collision cannot merge manager, grand, custom, consensus or modal identities', () => {
  const elements = {};
  const raw = [
    { guru:'A', cusip:'111111111', shares:10, value:100, period:'2026-09-30' },
    { guru:'A', cusip:'222222222', shares:20, value:300, period:'2026-09-30' },
    { guru:'B', cusip:'111111111', shares:30, value:600, period:'2026-06-30' },
    { guru:'C', cusip:'222222222', shares:40, value:1200, period:'2026-09-30' }
  ].map(row => ({...row, name:'Same issuer', ticker:'ABC', action:'HOLD', shareType:'SH'}));
  let opened;
  const c = context([...helpers, 'getMappedTicker', 'formatMoney', 'formatQuarterDisplay', 'processAndRenderHoldingsData', 'buildCustomGroupPortfolio', 'renderConsensusWidget', 'openConsensusStock', 'renderStockHoldersTable'], {
    RAW_HOLDINGS: raw, GURU_DATABASE:{}, DOMINANT_13F_PERIOD:null, CURRENT_CONSENSUS_TYPE:'HOLDERS',
    document: { getElementById: id => elements[id] ||= { innerHTML:'', children:[], appendChild(el) { this.children.push(el); } }, createElement: () => ({style:{}}) },
    getFavorites: () => ['A','B','C'], isDerivativeOrOption: () => false, getMappedSector: () => 'Other',
    renderCategoryTabs() {}, renderGuruSidebar() {}, selectGuru() {}, openStockModal(item) { opened=item; }
  });
  // Even an explicitly reviewed shared quote symbol must not become the grouping key.
  for (const cusip of ['111111111','222222222']) c.MARKET_SYMBOLS.reviewedCusips[cusip]={ticker:'ABC',sourceUrl:'https://example.test/reviewed'};
  c.processAndRenderHoldingsData();
  assert.equal(c.GURU_DATABASE.A.holdings.length,2);
  const grand=c.GURU_DATABASE.__GRAND_TOTAL__;
  assert.equal(grand.holdings.length,2);
  assert.equal(grand.rawAum,2200);
  const first=grand.holdings.find(h=>h.cusip==='111111111');
  const second=grand.holdings.find(h=>h.cusip==='222222222');
  assert.equal(first.rawShares,40);
  assert.equal(first.value,700);
  assert.equal(first.holders,2);
  assert.deepEqual(Array.from(first.periodRange), ['2026-06-30','2026-09-30']);
  assert.equal(second.rawShares,60);
  assert.equal(second.value,1500);
  assert.equal(second.holders,2);
  assert.equal((elements.consensusCardsGrid.innerHTML.match(/class="consensus-ticker">ABC/g)||[]).length,2);
  c.buildCustomGroupPortfolio();
  assert.equal(c.GURU_DATABASE.__CUSTOM_GROUP__.holdings.length,2);
  assert.equal(c.GURU_DATABASE.__CUSTOM_GROUP__.rawAum,2200);
  c.openConsensusStock(second.securityId);
  assert.equal(opened,second);
  c.renderStockHoldersTable(second);
  assert.equal(elements.modalHoldersCount.innerText,2);
  const holderRows=elements.modalHoldersBody.children.map(row=>row.innerHTML).join('');
  assert.match(holderRows,/<td>A<\/td>/);
  assert.match(holderRows,/<td>C<\/td>/);
  assert.doesNotMatch(holderRows,/<td>B<\/td>/);
});

test('missing identity rows remain separate while CUSIP duplicates aggregate without losing value', () => {
  const raw = [
    {name:'Same unknown issuer',ticker:'AAPL',shares:10,value:100},
    {name:'Same unknown issuer',ticker:'AAPL',shares:20,value:200},
    {name:'Known issuer',cusip:'037833100',shares:30,value:300},
    {name:'Known issuer alternate name',cusip:'037833100',shares:40,value:400}
  ].map(row=>({...row,guru:'A',period:'2026-09-30',action:'HOLD'}));
  const c=context([...helpers,'getMappedTicker','formatMoney','formatQuarterDisplay','processAndRenderHoldingsData','buildCustomGroupPortfolio'],{
    RAW_HOLDINGS:raw,GURU_DATABASE:{},DOMINANT_13F_PERIOD:null,
    isDerivativeOrOption:()=>false,getMappedSector:()=> 'Other',getFavorites:()=>['A'],
    renderCategoryTabs(){},renderGuruSidebar(){},selectGuru(){},renderConsensusWidget(){}
  });
  c.processAndRenderHoldingsData();
  for(const key of ['A','__GRAND_TOTAL__']){
    const fund=c.GURU_DATABASE[key];
    assert.equal(fund.holdings.length,3);
    assert.equal(fund.rawAum,1000);
    const known=fund.holdings.find(h=>h.cusip==='037833100');
    assert.equal(known.rawShares,70);
    assert.equal(known.value,700);
    assert.equal(new Set(fund.holdings.map(h=>h.securityId)).size,3);
    assert.equal(fund.holdings.filter(h=>h.ticker.startsWith('UNMAPPED:')).length,2);
  }
  c.buildCustomGroupPortfolio();
  assert.equal(c.GURU_DATABASE.__CUSTOM_GROUP__.holdings.length,3);
});

test('stale precomputed identity cannot override exact CUSIP or instrument type', () => {
  const c=context([]);
  const one={cusip:'084670108',securityId:'BRK.B'};
  const two={cusip:'084670702',securityId:'BRK.B'};
  assert.notEqual(c.holdingIdentity(one),c.holdingIdentity(two));
  assert.notEqual(c.holdingIdentity({...one,shareType:'SH'}),c.holdingIdentity({...one,shareType:'PRN'}));
  assert.notEqual(c.holdingIdentity({...one,putCall:'PUT'}),c.holdingIdentity({...one,putCall:'CALL'}));
});

test('bond ETF and similar issuer words preserve equity value; explicit derivatives stay separate', () => {
  const c=context([...helpers,'isDerivativeOrOption','getMappedTicker','formatMoney','formatQuarterDisplay','processAndRenderHoldingsData'],{
    RAW_HOLDINGS:[
      {guru:'A',name:'ISHARES CORE US AGGREGATE BOND ETF',cusip:'464287226',shareType:'SH',shares:10,value:100},
      {guru:'A',name:'OPTION CARE HEALTH',cusip:'68404L201',shareType:'SH',shares:20,value:200},
      {guru:'A',name:'Issuer',cusip:'037833100',shareType:'PRN',shares:30,value:300},
      {guru:'A',name:'Issuer',cusip:'037833100',shareType:'SH',putCall:'CALL',shares:40,value:400}
    ],GURU_DATABASE:{},DOMINANT_13F_PERIOD:null,getMappedSector:()=> 'Other',
    renderCategoryTabs(){},renderGuruSidebar(){},selectGuru(){},renderConsensusWidget(){}
  });
  c.processAndRenderHoldingsData();
  assert.equal(c.GURU_DATABASE.A.rawAum,300);
  assert.equal(c.GURU_DATABASE.A.holdings.length,2);
  assert.equal(c.GURU_DATABASE.__GRAND_TOTAL__.rawAum,300);
  assert.equal(c.isDerivativeOrOption('Bond issuer','ABC','SHS',{}),false);
  assert.equal(c.isDerivativeOrOption('Issuer','ABC CALL','',{}),true);
  assert.equal(c.isDerivativeOrOption('Issuer','ABC','NOTE',{}),true);
});

test('expired quote disappears before a pending upstream request resolves', async () => {
  let release;
  const h = { ticker: 'AAPL', curPrice: 100, priceChangePct: 5 };
  const c = context([...helpers, 'fetchLivePricesForCurrentView'], {
    priceRequestId: 0, state: { currentGuruKey: 'A', currentFilingType: '13F' }, GURU_DATABASE: { A: { holdings: [h] } },
    LIVE_PRICES: { AAPL: { ...fresh(100), marketTime: NOW / 1000 - 86401 } },
    fetch: () => new Promise(resolve => { release = resolve; }),
    updateSummaryMetrics() {}, renderTable() {}, refreshMacroSnapshot: async () => {}
  });
  const pending = c.fetchLivePricesForCurrentView();
  assert.equal(h.curPrice, null);
  assert.equal(h.priceChangePct, null);
  release({ ok: true, json: async () => ({}) });
  await pending;
});

test('metadata recovery rebinds the open modal to the verified holding identity', () => {
  const old = { ticker: 'CUSIP:037833100', cusip: '037833100', securityId: 'CUSIP:037833100|SH|EQUITY' };
  const next = { ...old, ticker: 'AAPL' };
  let opened;
  const c = context(helpers, {
    state: { currentGuruKey: 'A', currentFilingType: '13F' }, GURU_DATABASE: { A: { holdings: [next] } },
    LIVE_PRICES: { AAPL: fresh(100) }, ACTIVE_STOCK_ITEM: old,
    document: { getElementById: () => ({ classList: { contains: () => true } }) },
    updateSummaryMetrics() {}, renderTable() {}, openStockModal(item) { opened = item; }
  });
  c.refreshVisibleQuotes();
  assert.equal(c.ACTIVE_STOCK_ITEM, next);
  assert.equal(opened, next);
  assert.equal(opened.ticker, 'AAPL');
  assert.equal(opened.curPrice, 100);
});

test('polling preserves aggregate modal context while an individual manager is selected', () => {
  const shared = { ticker: 'AAPL', cusip: '037833100', securityId: 'CUSIP:037833100|SH|EQUITY' };
  const grand = { ...shared, value: 1000, weight: 20 };
  const manager = { ...shared, value: 100, weight: 5 };
  let opened;
  let shown;
  const c = context(helpers, {
    state: { currentGuruKey: 'A', currentFilingType: '13F' }, GURU_DATABASE: { A: { holdings: [manager] }, __GRAND_TOTAL__: { holdings: [grand] } },
    LIVE_PRICES: { AAPL: fresh(100) }, ACTIVE_STOCK_ITEM: grand, ACTIVE_STOCK_GURU_KEY: '__GRAND_TOTAL__',
    document: { getElementById: () => ({ classList: { contains: () => true } }) },
    updateSummaryMetrics() {}, renderTable() {}, openStockModal(item) { opened = item; }, renderStockQuote(item) { shown = item; }
  });
  c.refreshVisibleQuotes();
  assert.equal(c.ACTIVE_STOCK_ITEM, grand);
  assert.equal(opened, undefined);
  assert.equal(shown.value, 1000);
  const rebuilt = { ...grand, ticker: 'AAPL' };
  c.GURU_DATABASE.__GRAND_TOTAL__.holdings = [rebuilt];
  c.refreshVisibleQuotes();
  assert.equal(opened, rebuilt);
  assert.equal(c.ACTIVE_STOCK_ITEM.value, 1000);
});

test('quote-only table redraw retains already expanded pages', () => {
  const elements = {};
  let pageCount = 0;
  const c = context([...helpers, 'renderTable'], {
    state: { currentGuruKey: 'A', activeFilter: 'ALL', searchQuery: '', sortColumn: 'value', sortDirection: 'desc' },
    GURU_DATABASE: { A: { holdings: Array.from({ length: 135 }, (_, i) => ({ ticker: `T${i}`, name: `Issuer ${i}`, sector: 'Other', value: i })) } },
    CURRENT_PAGE_INDEX: 4, CURRENT_FILTERED_ITEMS: [],
    document: { getElementById: id => elements[id] ||= {} },
    appendNextPageRows() { pageCount++; c.CURRENT_PAGE_INDEX++; }
  });
  c.renderTable(true);
  assert.equal(pageCount, 3);
  assert.equal(c.CURRENT_PAGE_INDEX, 4);
  pageCount = 0;
  c.renderTable();
  assert.equal(pageCount, 1, 'new search/manager renders still begin at first page');
});


test('SH units cannot bypass explicit option and warrant class or ticker markers', () => {
  const rows = [
    { name:'Issuer', ticker:'AAPL', securityClass:'CALL' },
    { name:'Issuer', ticker:'AAPL', securityClass:'WARRANT' },
    { name:'Issuer', ticker:'AAPL CALL', securityClass:'COM' },
    { name:'Issuer', ticker:'AAPL PUT', securityClass:'COM' },
    { name:'ISHARES CORE US AGGREGATE BOND ETF', ticker:'AGG', cusip:'464287226', securityClass:'SHS' }
  ].map(row=>({guru:'A',cusip:'037833100',shareType:'SH',shares:10,value:100,...row}));
  const c=context([...helpers,'isDerivativeOrOption','getMappedTicker','formatMoney','formatQuarterDisplay','processAndRenderHoldingsData'],{
    RAW_HOLDINGS:rows,GURU_DATABASE:{},DOMINANT_13F_PERIOD:null,getMappedSector:()=> 'Other',
    LIVE_PRICES:{AAPL:fresh(100)},
    renderCategoryTabs(){},renderGuruSidebar(){},selectGuru(){},renderConsensusWidget(){}
  });
  for(const row of rows.slice(0,4)) assert.equal(c.isDerivativeOrOption(row.name,row.ticker,row.securityClass,row),true);
  assert.equal(c.isDerivativeOrOption('Issuer','AAPL','ETF CALL',{shareType:'SH'}),true);
  assert.equal(c.isDerivativeOrOption('Issuer','AAPL','ETF WARRANT',{shareType:'SH'}),true);
  assert.equal(c.isDerivativeOrOption(rows[4].name,rows[4].ticker,rows[4].securityClass,rows[4]),false);
  c.processAndRenderHoldingsData();
  assert.equal(c.GURU_DATABASE.A.holdings.length,1);
  assert.equal(c.GURU_DATABASE.A.rawAum,100);
  assert.equal(c.GURU_DATABASE.A.holdings[0].cusip,'464287226');
  assert.equal(c.GURU_DATABASE.A.holdings[0].curPrice,null);
});
