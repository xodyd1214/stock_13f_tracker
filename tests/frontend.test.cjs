const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');
function extract(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function context(names, extra = {}) {
  const ctx = vm.createContext({ console, ...extra });
  for (const name of names) vm.runInContext(extract(name), ctx);
  return ctx;
}
const helpers = ['hasPrice', 'priceLabel', 'priceDifference', 'insiderCode', 'insiderLabel', 'quoteFreshness'];
test('missing price is not a zero-percent live quote or discount', () => {
  const c = context([...helpers, 'applyLivePricesToHoldings'], { LIVE_PRICES: {} });
  const holdings = [{ ticker: 'AAPL', estPrice: 100, curPrice: 100 }];
  c.applyLivePricesToHoldings(holdings);
  assert.equal(holdings[0].curPrice, null);
  assert.equal(holdings[0].priceChangePct, null);
  assert.ok(Number.isNaN(c.priceDifference(holdings[0])));
  assert.equal(c.priceLabel(null), '시세 없음');
  c.LIVE_PRICES.AAPL = { price: 90, changePct: 0 };
  c.applyLivePricesToHoldings(holdings);
  assert.equal(c.priceDifference(holdings[0]), -10);
  assert.equal(holdings[0].priceChangePct, 0);
});
test('unmapped securities do not collide via issuer prefix and class ticker survives', () => {
  const c = context(['getMappedTicker'], { TICKER_MAP: { '037833100': 'AAPL' } });
  assert.notEqual(c.getMappedTicker('ISHARES FUND A', '', '111111111'), c.getMappedTicker('ISHARES FUND B', '', '222222222'));
  assert.equal(c.getMappedTicker('Berkshire', 'BRK.B', ''), 'BRK.B');
  assert.equal(c.getMappedTicker('Apple', '', '037833100'), 'AAPL');
  assert.ok(c.getMappedTicker('Unknown issuer', '', '').startsWith('UNMAPPED:'));
});
test('insider canonical codes distinguish buys, sales, awards, exercises and unknowns', () => {
  const c = context(helpers);
  assert.equal(c.insiderLabel({ txTypeCode: 'P' }), '장내 매수 (P)');
  for (const code of ['A', 'M', 'G', 'F', 'Z']) assert.notEqual(c.insiderLabel({ txTypeCode: code }), '장내 매도 (S)');
  assert.equal(c.insiderCode({ txTypeCode: 'A', transactionCode: 'P' }), 'A');
});
test('history displays an honest unavailable state, never synthesized quarters', () => {
  const children = [];
  const c = context(['renderStockHistoryTimeline'], { document: { getElementById: () => ({ appendChild: el => children.push(el) }), createElement: () => ({}) } });
  c.renderStockHistoryTimeline({ weight: 5 });
  assert.equal(children.length, 1);
  assert.match(children[0].textContent, /데이터가 없어/);
});
test('custom common holdings are HOLD and reference valuation uses aggregate shares', () => {
  const h = { ticker: 'ABC', baseTicker: 'ABC', rawShares: 10, value: 100, estPrice: 10, curPrice: null };
  const c = context(['formatMoney', 'formatQuarterDisplay', 'buildCustomGroupPortfolio'], { getFavorites: () => ['A', 'B'], selectGuru() {}, DOMINANT_13F_PERIOD: null, GURU_DATABASE: { A: { name: 'A', holdings: [h] }, B: { name: 'B', holdings: [{ ...h, rawShares: 20, value: 300, estPrice: 15 }] } } });
  c.buildCustomGroupPortfolio();
  const result = c.GURU_DATABASE.__CUSTOM_GROUP__.holdings[0];
  assert.equal(result.holders, 2);
  assert.equal(result.action, 'HOLD');
  assert.equal(result.estPrice, 400 / 30);
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
  const c = context([...helpers, 'renderModalInsiderCross'], { insiderRequestId: 0, FORM4_DATA: [], document: { getElementById: id => id === 'modalInsiderContent' ? content : { style: {} } }, fetch: () => new Promise(resolve => { finish = resolve; }) });
  const old = c.renderModalInsiderCross({ ticker: 'OLD' });
  c.insiderRequestId++;
  content.innerHTML = 'NEW MODAL';
  finish({ ok: true, json: async () => [] });
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
  assert.equal(renders, 0);
});
test('macro null observations display unknown instead of fabricated defaults', () => {
  const elements = {};
  const c = context(['macroFreshness', 'renderMacroPulseBar', 'renderMacroMarketProxies', 'renderMacroBenchmarks'], { MACRO_DATA: { schemaVersion: 2, benchmarks: { fedRate: { gapToNeutral: null }, inflation: { gapToTarget: null } }, treasury: { spread10Y_13W: { spread: null }, yield10Y: { val: null } }, commoditiesAndFx: { gold: { val: null } } }, document: { getElementById: id => elements[id] ||= {} } });
  c.renderMacroPulseBar();
  c.renderMacroMarketProxies();
  c.renderMacroBenchmarks();
  const html = elements.macroPulseBar.innerHTML + elements.macroMarketProxyGrid.innerHTML;
  assert.match(html, /확인 불가/);
  assert.doesNotMatch(html, /4\.80|3\.77|3\.4|92\.36|4430|null|NaN/);
});
test('invalid treasury observations cannot turn null into zero-yield chart points', () => {
  const c = context(['getFilteredTreasuryData'], { MACRO_DATA: { timeSeries: { treasuryDaily: [{ date: '2026-01-01', y3m: null, y5y: 2, y10y: 3, spread: 1 }, { date: '2026-01-02', y3m: 1, y5y: 2, y10y: 3, spread: 2 }] } } });
  assert.equal(c.getFilteredTreasuryData('1M').length, 1);
});
test('holdings pipeline preserves source actions and does not create missing quotes', () => {
  const c = context([...helpers, 'getMappedTicker', 'formatMoney', 'formatQuarterDisplay', 'processAndRenderHoldingsData'], { RAW_HOLDINGS: [{ guru: 'Manager', name: 'Unmapped Fund A', cusip: '111111111', shares: 10, value: 100, period: '2026-06-30', action: 'UNKNOWN' }, { guru: 'Manager', name: 'Unmapped Fund B', cusip: '222222222', shares: 20, value: 400, period: '2026-06-30', action: 'HOLD' }], GURU_DATABASE: {}, LIVE_PRICES: {}, TICKER_MAP: {}, DOMINANT_13F_PERIOD: null, isDerivativeOrOption: () => false, getMappedSector: () => 'Unknown', renderCategoryTabs() {}, renderGuruSidebar() {}, selectGuru() {}, renderConsensusWidget() {} });
  c.processAndRenderHoldingsData();
  assert.equal(c.GURU_DATABASE.Manager.holdings.length, 2);
  const first = c.GURU_DATABASE.Manager.holdings.find(h => h.cusip === '111111111');
  assert.equal(first.action, 'UNKNOWN');
  assert.equal(first.estPrice, 10);
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
  const c = context(['normalizeMacroData', 'macroFreshness', 'quoteFreshness', 'renderMacroMarketProxies'], { MACRO_DATA: data, document: { getElementById: id => elements[id] ||= {} } });
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
  const c = context(['hasPrice', 'normalizeMacroData', 'refreshMacroSnapshot', 'fetchLivePricesForCurrentView'], { refreshMacroSnapshot: async () => {}, priceRequestId: 0, state: { currentGuruKey: 'A', currentFilingType: '13F' }, GURU_DATABASE: { A: { holdings: [] } }, LIVE_PRICES: {}, MACRO_DATA: snapshot, fetch: async url => url.startsWith('/api/') ? { ok: false } : url.startsWith('realtime_') ? { ok: false } : new Promise(resolve => { release = resolve; }), renderMacroPulseBar() { throw new Error('Stale macro render'); } });
  const pending = c.fetchLivePricesForCurrentView();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  c.priceRequestId++;
  release({ ok: true, json: async () => ({ schemaVersion: 2, status: 'stale' }) });
  await pending;
  assert.equal(c.MACRO_DATA, snapshot);
});
test('API and static quote paths both fully redraw refreshed macro snapshots', async () => {
  for (const apiOk of [true, false]) {
    let redraws = 0;
    const next = { schemaVersion: 2, status: 'success', treasury: {} };
    const c = context(['hasPrice', 'normalizeMacroData', 'refreshMacroSnapshot', 'fetchLivePricesForCurrentView'], { priceRequestId: 0, state: { currentGuruKey: 'A', currentFilingType: 'MACRO' }, GURU_DATABASE: { A: { holdings: [] } }, LIVE_PRICES: {}, MACRO_DATA: {}, fetch: async url => url.startsWith('/api/') ? { ok: apiOk, json: async () => ({}) } : url.startsWith('realtime_') ? { ok: false } : { ok: true, json: async () => next }, loadAndRenderMacro: async () => { redraws++; } });
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
