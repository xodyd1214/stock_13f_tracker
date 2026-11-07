const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
function extract(name) {
  const start = app.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return app.slice(start, app.indexOf('\n}', start) + 2);
}
function row(extra = {}) { return { rawSource:{putCall:null}, legalName: 'MARKEL GROUP INC', cik: '0001096343', name: 'Example', cusip: '123456789', ticker: 'ABC', shareType: 'SH', putCall: '', shares: 100, value: 900, period: '2026-06-30', filingDate: '2026-08-01', accession: '0001096343-26-000001', sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1096343/000109634326000001/table.xml', tableSha256: 'a'.repeat(64), sourceRowId: 'source:1', ...extra }; }
function context(rows, valid = true) {
 const display = {rows, sources: rows, coverage: { labels: [] }, freshness: { lastCheckedAt: '2026-11-05T00:00:00Z', label: '최근 확인' }};
 const nodes = new Map(); const document = { getElementById: id => nodes.get(id) || null };
 const ctx = vm.createContext({SECDisplayLoader:require('../sec_display_loader.js'),URL, console, Date, document, RAW_HOLDINGS: rows, SEC_DISPLAY: valid ? display : null, SEC_DISPLAY_ROWS: new WeakSet(rows), GURU_DATABASE: {}, DOMINANT_13F_PERIOD: null, LIVE_PRICES: {}, CURRENT_CONSENSUS_TYPE: 'HOLDERS', TICKER_MAP: {}, MARKET_SYMBOLS: null,
   state: { currentGuruKey: '__GRAND_TOTAL__' }, isDerivativeOrOption: () => false, getMappedTicker: () => 'ABC', getMappedSector: () => 'Other', quoteFields: () => ({curPrice:null}), priceLabel: () => '미검증',
   renderCategoryTabs() {}, renderGuruSidebar() {}, selectGuru() {}, renderConsensusWidget() {},
   holdingIdentity: r => [r.cusip, r.shareType, r.putCall].join('|') });
 for (const name of ['safeSecUrl', 'escapeHtml', 'verifiedDisplayRow','showUnavailableHoldings','formatMoney','formatQuarterDisplay','processAndRenderHoldingsData','buildPartialCsv']) vm.runInContext(extract(name), ctx);
 return {ctx, nodes, display};
}
test('real processing rejects legacy rows and produces null total rather than zero holdings claim', () => {
 const {ctx} = context([row()], false); ctx.processAndRenderHoldingsData();
 assert.equal(ctx.GURU_DATABASE.__GRAND_TOTAL__.rawAum, null);
 assert.equal(ctx.GURU_DATABASE.__GRAND_TOTAL__.holdings.length, 0);
 assert.throws(() => ctx.buildPartialCsv(ctx.GURU_DATABASE.__GRAND_TOTAL__), /unavailable/);
 assert.doesNotMatch(extract('loadRealSecData'), /latest_13f_holdings/);
});
test('processing and CSV use legal entity, UNKNOWN actions, no inferred cost and immutable sources', () => {
 const rows = [Object.freeze(row({guru:'Tom Gayner', action:'ADD'}))]; const before = JSON.stringify(rows);
 const {ctx} = context(rows); ctx.processAndRenderHoldingsData();
 const g = ctx.GURU_DATABASE['MARKEL GROUP INC'];
 assert.ok(g); assert.equal(ctx.GURU_DATABASE['Tom Gayner'], undefined);
 assert.equal(g.rawAum, 900); assert.equal(g.holdings[0].estPrice, null); assert.equal(g.holdings[0].action, 'UNKNOWN');
 assert.equal(ctx.GURU_DATABASE.__GRAND_TOTAL__.holdings[0].holders, 1);
 const csv = ctx.buildPartialCsv(g);
 assert.match(csv, /43\/50/); assert.match(csv, /42 SEC/); assert.match(csv, /UNKNOWN/); assert.match(csv, /2026-06-30/); assert.match(csv, /2026-08-01/); assert.match(csv, /www.sec.gov/);
 assert.equal(JSON.stringify(rows), before);
});
test('missing shares, option flags or provenance never enter numeric processing or CSV', () => {
 for (const bad of [{shares:null}, {putCall:undefined}, {shareType:null}, {sourceRowId:undefined}, {tableSha256:'bad'}]) {
  const {ctx} = context([row(bad)]); ctx.processAndRenderHoldingsData();
  assert.equal(ctx.GURU_DATABASE.__GRAND_TOTAL__.rawAum, null);
  assert.equal(ctx.GURU_DATABASE.__GRAND_TOTAL__.holdings.length, 0);
  assert.doesNotMatch(ctx.buildPartialCsv(ctx.GURU_DATABASE.__GRAND_TOTAL__), /"900"/);
 }
});
test('real consensus uses checked rows and legal entity identity only', () => {
 const rows = [row({guru:'Tom Gayner'}), row({guru:'Markel Asset Management',sourceRowId:'source:2',value:100})];
 const {ctx,nodes} = context(rows); const grid={innerHTML:''}; nodes.set('consensusCardsGrid',grid);
 vm.runInContext(extract('renderConsensusWidget'), ctx);
 ctx.renderConsensusWidget('HOLDERS');
 assert.match(grid.innerHTML, /1개사 보유/);
 assert.doesNotMatch(grid.innerHTML, /2개사 보유/);
});
test('coverage renders all 50 tracked labels, alias count and seven pending without invented zeros', () => {
 const {ctx, nodes, display} = context([]);
 const scope = JSON.parse(fs.readFileSync(path.join(__dirname, '../partial_display_scope.json')));
 display.coverage.labels = scope.originalLabels.map(label => {
   const available = scope.eligible.find(item => item.label === label);
   return available ? {...available,status:'available'} : {label,status:'verification-pending',reason:'source verification pending',holdings:null,totalValue:null};
 });
 function element() { return {children:[],textContent:'',replaceChildren(){this.children=[]},appendChild(c){this.children.push(c)}}; }
 ctx.document.createElement = element;
 const list = element(), status=element(); nodes.set('partialCoverageList',list); nodes.set('partialDisplayStatus',status);
 vm.runInContext(extract('renderPartialCoverage'),ctx); ctx.renderPartialCoverage();
 assert.equal(list.children.length,50);
 assert.equal(display.coverage.labels.filter(x=>x.status==='available').length,43);
 assert.equal(new Set(display.coverage.labels.filter(x=>x.status==='available').map(x=>x.cik)).size,42);
 assert.equal(display.coverage.labels.filter(x=>x.status==='verification-pending').length,7);
 for (const item of list.children.filter(x=>x.textContent.includes('검증 중'))) assert.match(item.textContent,/보유 수치 없음/);
 assert.match(status.textContent,/42개 SEC/); assert.match(status.textContent,/현재 실시간 포트폴리오가 아닙니다/);
});
const loader = require('../sec_display_loader.js');
const crypto = require('node:crypto');
function transportFixture() {
 const scope = JSON.parse(fs.readFileSync(path.join(__dirname,'../partial_display_scope.json')));
 // Synthetic transport fixtures omit real classification proofs; real-bundle tests read actual pinned bytes.
 scope.equityShareClassOverrides = [];
 const scopeBytes = Buffer.from(JSON.stringify(scope)), hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
 const scopeHash = hash(scopeBytes), entities = [...new Map(scope.eligible.map(x=>[x.cik,x])).values()];
 const rows = entities.map((entity,i) => {
  const accession = `${entity.cik}-26-${String(i).padStart(6,'0')}`;
  return row({schemaVersion:3,legalName:entity.legalName,cik:entity.cik,accession,sourceRow:1,sourceRowId:`${accession}:${'a'.repeat(64)}:1`,sourceUrl:`https://www.sec.gov/Archives/edgar/data/${Number(entity.cik)}/${accession.replace(/-/g,'')}/table.xml`,primarySourceUrl:`https://www.sec.gov/Archives/edgar/data/${Number(entity.cik)}/${accession.replace(/-/g,'')}/primary.xml`,valueUsd:900,sourceReportedValue:900,valueMultiplier:1,sourceValueUnit:'USD',sourceValue:'900',sourceShares:'100',rawSource:{shares:'100',rawValue:'900',putCall:null},primarySha256:'b'.repeat(64),valueUnit:'USD',verificationStatus:'source_reconciled',managerIdentityStatus:'verified',action:'UNKNOWN',titleOfClass:'COM'});
 });
 const columns = Object.keys(rows[0]).map(key=>[key]);
 const projection = {schemaVersion:1,format:'lossless_grouped_rows_v1',rowCount:rows.length,groups:[{common:[],columns,rows:rows.map(r=>columns.map(([key])=>r[key]))}]};
 const coverage={schemaVersion:1,contract:scope.contract,counts:{originalLabels:50,availableLabels:43,availableEntities:42,pendingLabels:7},labels:scope.originalLabels.map(label=>{
  const item=scope.eligible.find(x=>x.label===label); const pending=scope.pending.find(x=>x.label===label);
  return item?{...item,status:'available',entityId:item.cik,reportDate:'2026-06-30',valueUsd:900,holdingsCount:1}:{...pending,status:'verification-pending',reportDate:null,valueUsd:null,holdingsCount:null,entityId:null};
 })};
 const manifest={schemaVersion:3,contract:scope.contract,scopeSha256:scopeHash,partialDisplayEligible:true,releaseEligible:false,migrationReady:false,originalLabelCount:50,availableLabelCount:43,availableEntityCount:42,pendingLabelCount:7,sourceReportDates:['2026-06-30'],holdingsRowCount:42,totalEquityValueUsd:37800,lastChecked:'2026-11-05T00:00:00Z',preparedAt:'2026-11-05T00:01:00Z',acquisitionStartedAt:'2026-11-04T23:00:00Z',sources:rows.map(r=>({cik:r.cik,legalName:r.legalName,accession:r.accession,period:r.period,filingDate:r.filingDate,tableSha256:r.tableSha256,primarySha256:r.primarySha256,sourceUrl:r.sourceUrl,primarySourceUrl:r.sourceUrl.replace('table.xml','primary.xml')}))};
 manifest.positionClassificationScope='available_reporting_entities';manifest.positionClassification=Object.fromEntries(['equity','equity_verified_fund_share','option','principal','warrant','unresolved_share_class'].map(kind=>[kind,{rowCount:kind==='equity'?42:0,reportedValueUsd:kind==='equity'?37800:0}]));
 const files=new Map(), base='https://example.com/repo/',calls=[];
 const config={contract:scope.contract,expectedScopeSha256:scopeHash,pointerPath:'sec-data/current.json',policyPath:'sec-data/display-policy.json'};
 function rebuild(){
  files.clear(); const payload={'projection.json':projection,'manifest.json':manifest,'coverage.json':coverage}; const refs={}; const encoded={};
  for(const [name,obj] of Object.entries(payload)){const data=Buffer.from(JSON.stringify(obj)); encoded[name]=data; refs[name]={sha256:hash(data),bytes:data.length};}
  const descriptor=Buffer.from(JSON.stringify({schemaVersion:1,artifactType:'sec_13f_partial_pages_generation',scopeSha256:scopeHash,files:refs})),id=hash(descriptor), prefix=base+`sec-data/generations/${id}/`;
  files.set(base+config.policyPath,scopeBytes); files.set(base+config.pointerPath,Buffer.from(JSON.stringify({schemaVersion:1,contract:scope.contract,generationId:id}))); files.set(prefix+'generation.json',descriptor);
  for(const [name,data] of Object.entries(encoded)) files.set(prefix+name,data);
 }
 rebuild();
 const fetch = async url => {calls.push(url); const body=files.get(url); return new Response(body || 'missing',{status:body?200:404});};
 const options={baseURL:base,config,fetch,crypto:crypto.webcrypto,now:Date.parse('2026-11-05T01:00:00Z')};
 return {rows,projection,coverage,manifest,files,calls,options,rebuild};
}
test('hashed transport preserves rows exactly, pins one pointer, and resolves repo subpath',async()=>{
 const f=transportFixture(); const result=await loader.load(f.options);
 assert.deepEqual(result.rows,f.rows); assert.equal(result.coverage.labels.length,50); assert.equal(result.manifest.availableEntityCount,42); assert.equal(result.freshness.stale,false);
 assert.equal(f.calls.filter(x=>x.endsWith('/current.json')).length,1); assert.equal(f.calls.filter(x=>x.endsWith('/display-policy.json')).length,2);
 assert.ok(f.calls.every(x=>x.startsWith('https://example.com/repo/'))); assert.ok(!f.calls.some(x=>/history|latest_13f/.test(x)));
});
test('loader rejects corrupt/missing/oversized payloads without legacy fallback',async()=>{
 for(const mode of ['corrupt','missing','oversize']){
  const f=transportFixture();const target=[...f.files.keys()].find(x=>x.endsWith('/projection.json'));
  if(mode==='missing') f.files.delete(target); else f.files.set(target,mode==='corrupt'?Buffer.from('{}'):Buffer.alloc(loader.LIMITS.projection+1));
  await assert.rejects(loader.load(f.options),/unavailable/); assert.ok(!f.calls.some(x=>x.includes('latest_13f')));
 }
});
test('policy revocation after payload fails, while pointer change does not alter pinned generation',async()=>{
 const f=transportFixture(); const fetch=f.options.fetch; let policy=0;
 f.options.fetch=async(url,opts)=>{if(url.endsWith('/display-policy.json')&&++policy===2)return new Response('{}');return fetch(url,opts);};
 await assert.rejects(loader.load(f.options),/revoked during load/);
 const g=transportFixture(); const original=g.options.fetch;
 g.options.fetch=async(url,opts)=>{const response=await original(url,opts);if(url.endsWith('/current.json'))g.files.set(url,Buffer.from('{}'));return response;};
 assert.equal((await loader.load(g.options)).rows.length,42); assert.equal(g.calls.filter(x=>x.endsWith('/current.json')).length,1);
});
test('old valid snapshots carry stale labels, future proof timestamps reject',async()=>{
 const f=transportFixture(); f.options.now=Date.parse('2026-11-07T00:00:00Z');
 const result=await loader.load(f.options);assert.equal(result.freshness.stale,true);assert.match(result.freshness.label,/오래된 확인/);
 const g=transportFixture();g.manifest.lastChecked='2026-11-06T00:00:00Z';g.rebuild();await assert.rejects(loader.load(g.options),/future/);
});
test('decoder rejects dangerous, duplicate and prefix-conflicting paths',()=>{
 for(const columns of [[['__proto__','polluted']], [['a'],['a']], [['a'],['a','b']]])assert.throws(()=>loader.decode({schemaVersion:1,format:'lossless_grouped_rows_v1',rowCount:1,groups:[{common:[],columns,rows:[columns.map(()=>1)]}]}),/path/);
});
test('coverage pending values, wrong aliases, unsafe provenance and numeric sums fail admission',async()=>{
 for(const mode of ['pending','alias','sum','provenance']){
  const f=transportFixture();
  if(mode==='pending')f.coverage.labels.find(x=>x.status==='verification-pending').valueUsd=0;
  if(mode==='alias')f.coverage.labels.find(x=>x.status==='available').legalName='Incorrect person claim';
  if(mode==='sum')f.manifest.totalEquityValueUsd++;
  if(mode==='provenance'){const index=f.projection.groups[0].columns.findIndex(p=>p[0]==='tableSha256');f.projection.groups[0].rows[0][index]='bad';}
  f.rebuild();await assert.rejects(loader.load(f.options),/unavailable/);
 }
});
test('startup opens Macro without loading filings, and 13F shares in-flight loads and retries failures', async () => {
 const {ctx, display} = context([row()], false);
 const fetched = [];
 const modes = [];
 let enter, poll, rejectLoad, loadCount = 0;
 Object.assign(ctx, {
   secDisplayLoad: null, priceRequestId: 0, console: {error() {}},
   document: {
     baseURI: 'https://example.com/repo/index.html',
     addEventListener(event, handler) { assert.equal(event, 'DOMContentLoaded'); enter = handler; },
     getElementById: () => null
   },
   SECDisplayLoader: {
     load() {
       if (++loadCount === 1) return new Promise((resolve, reject) => { rejectLoad = reject; });
       return Promise.resolve(display);
     }
   },
   loadDashboardSnapshot: async file => { fetched.push(file); return null; },
   mergeObservedPrices() {}, renderPartialCoverage() {}, initFirebase() {}, setupEventListeners() {},
   initMobileInteractions() {}, initFilingDdayCountdown() {}, initConsensusTabs() {},
   switchFilingMode(mode) { modes.push(mode); },
   setInterval(handler) { poll = handler; },
   refreshMacroSnapshot() { modes.push('macro-refresh'); }
 });
 vm.runInContext(extract('loadRealSecData'), ctx);
 const startup = app.indexOf('document.addEventListener("DOMContentLoaded"');
 vm.runInContext(app.slice(startup, app.indexOf('\n});', startup) + 4), ctx);
 enter();
 poll();
 assert.deepEqual(modes, ['MACRO', 'macro-refresh']);
 assert.equal(loadCount, 0);
 assert.deepEqual(fetched, []);

 const first = ctx.loadRealSecData();
 const concurrent = ctx.loadRealSecData();
 assert.equal(loadCount, 1);
 rejectLoad(new Error('corrupt generation'));
 await Promise.all([first, concurrent]);
 assert.equal(ctx.SEC_DISPLAY, null);
 assert.equal(ctx.GURU_DATABASE.__GRAND_TOTAL__.rawAum, null);
 await ctx.loadRealSecData();
 await ctx.loadRealSecData();
 assert.equal(loadCount, 2);
 assert.equal(ctx.SEC_DISPLAY, display);
 assert.deepEqual(fetched, [
   'ticker_map.json', 'realtime_prices.json', 'market_symbols.json',
   'ticker_map.json', 'realtime_prices.json', 'market_symbols.json'
 ]);
});
test('redirects and unsafe config paths fail closed',async()=>{
 const f=transportFixture();f.options.fetch=async()=>({ok:true,redirected:true});await assert.rejects(loader.load(f.options),/redirected/);
 const g=transportFixture();g.options.config.pointerPath='../current.json';await assert.rejects(loader.load(g.options),/unsafe artifact path/);
});
test('admitted Vanguard short-term bond fund SH survives processing, consensus and CSV unchanged',()=>{
 const r=row({schemaVersion:3,legalName:'RENAISSANCE TECHNOLOGIES LLC',cik:'0001037389',name:'VANGUARD BD INDEX FDS',cusip:'921937827',titleOfClass:'SHORT TRM BOND',securityClass:'SHORT TRM BOND',shares:91055,value:7094095});
 const {ctx,nodes}=context([r]); vm.runInContext(extract('isDerivativeOrOption'),ctx);
 assert.equal(ctx.isDerivativeOrOption(r.name,'',r.titleOfClass,r),true,'legacy heuristic alone would incorrectly exclude this source row');
 ctx.processAndRenderHoldingsData();assert.equal(ctx.GURU_DATABASE.__GRAND_TOTAL__.rawAum,7094095);assert.equal(ctx.GURU_DATABASE[r.legalName].holdings[0].rawShares,91055);
 assert.match(ctx.buildPartialCsv(ctx.GURU_DATABASE.__GRAND_TOTAL__),/"91055","7094095"/);
 const grid={innerHTML:''};nodes.set('consensusCardsGrid',grid);vm.runInContext(extract('renderConsensusWidget'),ctx);ctx.renderConsensusWidget();assert.match(grid.innerHTML,/1개사 보유/);assert.match(grid.innerHTML,/7\.1M/);
});
test('freshness ages oldest source check, not only newest source check',async()=>{
 const f=transportFixture(); f.manifest.acquisitionStartedAt='2026-11-03T23:00:00Z'; f.rebuild();
 const result=await loader.load(f.options);assert.equal(result.freshness.stale,true);assert.equal(result.freshness.ageHours,26);assert.equal(result.freshness.lastCheckedAt,'2026-11-05T00:00:00Z');
});
test('source text is escaped at table, treemap, sidebar, holder and consensus HTML sinks without mutating rows',()=>{
 const attack=`<img src=x onerror="alert(1)"> ' &`;
 const r=Object.freeze(row({schemaVersion:3,name:attack,legalName:attack,titleOfClass:'COM'})), original=JSON.stringify(r);
 const {ctx,nodes}=context([r]);ctx.processAndRenderHoldingsData();
 function element(){return{innerHTML:'',children:[],style:{},classList:{add(){},remove(){},toggle(){}},events:{},appendChild(e){this.children.push(e)},addEventListener(name,fn){this.events[name]=fn}};}
 ctx.document.createElement=element;ctx.document.createDocumentFragment=element;
 const table=element(),treemap=element(),tooltip=element(),sidebar=element(),holders=element(),count=element(),consensus=element();
 for(const [id,el] of Object.entries({tableBody:table,treemapContainer:treemap,treemapTooltip:tooltip,guruList:sidebar,modalHoldersBody:holders,modalHoldersCount:count,consensusCardsGrid:consensus}))nodes.set(id,el);
 const h=ctx.GURU_DATABASE.__GRAND_TOTAL__.holdings[0];h.ticker=attack;h.sector=attack;h.quoteAsOf=attack;
 Object.assign(ctx,{CURRENT_FILTERED_ITEMS:[h],CURRENT_PAGE_INDEX:1,PAGE_SIZE:60,priceDifference:()=>NaN,priceComparisonReason:()=>attack,applyColumnVisibility(){},getCleanCompanyName:()=>attack,computeSquarifiedTreemap:()=>[{item:h,width:200,height:200,x:0,y:0}],CURRENT_USER:null,getFavorites:()=>[],getMappedTicker:()=>attack});
 for(const fn of ['appendNextPageRows','renderTreemap','renderGuruSidebar','renderStockHoldersTable','renderConsensusWidget'])vm.runInContext(extract(fn),ctx);
 ctx.appendNextPageRows();ctx.renderTreemap([h]);treemap.children[0].events.mouseenter({clientX:0,clientY:0});ctx.renderGuruSidebar();ctx.renderStockHoldersTable(h);ctx.renderConsensusWidget();
 const outputs=[table.children[0].children[0].innerHTML,treemap.children[0].innerHTML,tooltip.innerHTML,sidebar.children[0].children[0].innerHTML,holders.children[0].innerHTML,consensus.innerHTML];
 for(const html of outputs){assert.doesNotMatch(html,/<img\b/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/title="<img/);}
 assert.equal(JSON.stringify(r),original);
});
test('clock is re-read after downloads when crossing oldest-source 24h boundary',async()=>{
 const f=transportFixture();let now=Date.parse('2026-11-05T22:59:00Z');f.options.now=()=>now;
 const original=f.options.fetch;let checks=0;f.options.fetch=async(url,opts)=>{const result=await original(url,opts);if(url.endsWith('display-policy.json')&&++checks===2)now=Date.parse('2026-11-05T23:01:00Z');return result;};
 const result=await loader.load(f.options);assert.equal(result.freshness.stale,true);assert.ok(result.freshness.ageHours>24);
});
test('source descriptor hashes, positive row ordinal and date-based value units must reconcile',async()=>{
 for(const mode of ['tableHash','primaryHash','zeroOrdinal','wrongUnits']){
  const f=transportFixture();const group=f.projection.groups[0];const set=(key,value)=>{group.rows[0][group.columns.findIndex(p=>p[0]===key)]=value;};
  if(mode==='tableHash')f.manifest.sources[0].tableSha256='c'.repeat(64);
  if(mode==='primaryHash')f.manifest.sources[0].primarySha256='c'.repeat(64);
  if(mode==='zeroOrdinal'){set('sourceRow',0);set('sourceRowId',`${f.rows[0].accession}:${'a'.repeat(64)}:0`);}
  if(mode==='wrongUnits'){set('valueMultiplier',1000);set('value',900000);set('valueUsd',900000);set('sourceValueUnit','THOUSANDS_USD');for(const item of f.coverage.labels.filter(x=>x.cik===f.rows[0].cik))item.valueUsd=900000;f.manifest.totalEquityValueUsd+=899100;}
  f.rebuild();await assert.rejects(loader.load(f.options),/unavailable/);
 }
});
test('adjacent SEC and macro feeds escape hostile text and reject executable or off-origin links',()=>{
 const attack='<img src=x onerror="alert(1)">';const {ctx,nodes}=context([]);
 const element=()=>({innerHTML:'',style:{},children:[],setAttribute(){},appendChild(x){this.children.push(x)}});ctx.document.createElement=element;ctx.document.createDocumentFragment=element;
 for(const url of ['javascript:alert(1)','data:text/html,test','https://sec.gov.evil.test/','https://evil.test/','https://user:pass@www.sec.gov/','http://www.sec.gov/'])assert.equal(ctx.safeSecUrl(url),'#');
 assert.equal(ctx.safeSecUrl('https://www.sec.gov/Archives/example.htm'),'https://www.sec.gov/Archives/example.htm');
 const d13=element();nodes.set('d13TableBody',d13);ctx.FILING_13D_DATA=[{filingDate:attack,formType:attack,investorName:attack,fundName:attack,targetCompany:attack,targetTicker:attack,percentOwned:attack,docUrl:'javascript:alert(1)'}];
 vm.runInContext(extract('render13DTable'),ctx);ctx.render13DTable();assert.doesNotMatch(d13.children[0].innerHTML,/<img|href="javascript:/);assert.match(d13.children[0].innerHTML,/&lt;img/);
 const macro=element();nodes.set('macroCalendarGrid',macro);
 const event={name:attack,category:'FED',date:attack,releaseDate:attack,releaseAt:new Date(Date.now()+86400000).toISOString().replace(/\.\d+Z$/,'Z')};
 ctx.MACRO_DATA={calendar:[{...event,sourceUrl:'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'},{...event,sourceUrl:'javascript:alert(1)'}]};
 for(const fn of ['upcomingMacroEvents','macroHelpButton','renderMacroCalendar'])vm.runInContext(extract(fn),ctx);
 ctx.renderMacroCalendar();assert.doesNotMatch(macro.innerHTML,/<img|href="javascript:/);assert.match(macro.innerHTML,/&lt;img/);
 const f4=element();nodes.set('f4TableBody',f4);
 Object.assign(ctx,{state:{f4Filter:'DIRECT'},CURRENT_F4_FILTERED_ITEMS:[{filingDate:attack,transDate:attack,ticker:attack,companyName:attack,securityTitle:attack,insiderName:attack,officerTitle:attack,txTypeCode:attack,ownership:attack,secUrl:'data:text/html,test'}],CURRENT_F4_PAGE_INDEX:1,F4_PAGE_SIZE:60});
 for(const fn of ['appendNextF4PageRows','form4Dates','form4Security','form4Relationship','form4Price','form4PriceWithBasis','insiderCode','insiderLabel'])vm.runInContext(extract(fn),ctx);
 ctx.appendNextF4PageRows();
 const f4Row=f4.children[0].children[0].innerHTML;
 assert.doesNotMatch(f4Row,/<img|href="data:/);
 assert.match(f4Row,/&lt;img/);
 assert.match(f4Row,/href="#"/);
});
if (process.env.SEC_REAL_BUNDLE) test('real exported generation reconciles exact rows, 42 entities, UI, CSV and bond-fund shares',async()=>{
 const root=path.resolve(process.env.SEC_REAL_BUNDLE);const configContext={};vm.runInNewContext(fs.readFileSync(path.join(root,'sec-display-config.js'),'utf8'),configContext);
 const calls=[];const result=await loader.load({baseURL:'https://example.com/repo/',config:configContext.SEC_DISPLAY_CONFIG,crypto:crypto.webcrypto,now:Date.parse('2026-11-05T23:00:00Z'),fetch:async url=>{calls.push(url);const relative=new URL(url).pathname.slice('/repo/'.length);try{return new Response(fs.readFileSync(path.join(root,relative)));}catch{return new Response('',{status:404});}}});
 assert.equal(result.rows.length,39753);assert.equal(result.manifest.totalEquityValueUsd,1548461288506);assert.equal(new Set(result.rows.map(r=>r.cik)).size,42);
 assert.equal(result.manifest.positionClassification.equity_verified_fund_share.rowCount,4);assert.equal(result.manifest.positionClassification.equity_verified_fund_share.reportedValueUsd,2080306);
 const before=crypto.createHash('sha256').update(JSON.stringify(result.rows)).digest('hex');const {ctx,nodes}=context(result.rows);ctx.SEC_DISPLAY=result;ctx.SEC_DISPLAY_ROWS=new WeakSet(result.rows);
 ctx.MARKET_SYMBOLS=JSON.parse(fs.readFileSync(path.join(root,'market_symbols.json')));ctx.TICKER_MAP=JSON.parse(fs.readFileSync(path.join(root,'ticker_map.json')));for(const fn of ['isDerivativeOrOption','holdingIdentity','canonicalTicker','getMappedTicker','hasPrice','priceLabel','quoteStatus','quoteFreshness','quoteFields'])vm.runInContext(extract(fn),ctx);ctx.processAndRenderHoldingsData();const grand=ctx.GURU_DATABASE.__GRAND_TOTAL__;
 assert.equal(grand.rawAum,result.manifest.totalEquityValueUsd);assert.equal(Object.keys(ctx.GURU_DATABASE).length,43);
 for(const entity of new Set(result.rows.map(r=>r.cik))){const source=result.coverage.labels.find(x=>x.cik===entity&&x.status==='available');assert.equal(ctx.GURU_DATABASE[source.legalName].rawAum,source.valueUsd);}
 const bonds=result.rows.filter(r=>ctx.isDerivativeOrOption(r.name,r.ticker,r.titleOfClass,r));assert.equal(bonds.length,6);assert.equal(bonds.reduce((s,r)=>s+r.value,0),44155721);
 for(const r of bonds)assert.ok(ctx.GURU_DATABASE[r.legalName].holdings.some(h=>h.cusip===r.cusip));
 const csv=ctx.buildPartialCsv(grand);assert.match(csv,/1548461288506|확인된 공시 부분집합/);assert.match(csv,/43\/50/);assert.match(csv,/UNKNOWN/);
 let csvTotal=0,csvCount=0;for(const line of csv.split('\n')){const cells=[...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(m=>m[1].replace(/""/g,'"'));if(cells.length===14&&cells[6]==='UNKNOWN'){csvTotal+=Number(cells[8]);csvCount++;}}assert.equal(csvTotal,result.manifest.totalEquityValueUsd);assert.equal(csvCount,grand.holdings.length);
 const grid={innerHTML:''};nodes.set('consensusCardsGrid',grid);vm.runInContext(extract('renderConsensusWidget'),ctx);ctx.renderConsensusWidget();assert.match(grid.innerHTML,/개 SEC 신고 법인/);
 assert.equal(crypto.createHash('sha256').update(JSON.stringify(result.rows)).digest('hex'),before);assert.equal(calls.filter(x=>x.endsWith('current.json')).length,1);
 console.log(`REAL VERIFIED: ${result.rows.length} rows; $${grand.rawAum}; 42 entities; six bond-share rows $44155721; ${calls.length} bounded artifact reads.`);
});
test('blank source numeric strings cannot coerce into verified zero values',async()=>{
 const f=transportFixture(),group=f.projection.groups[0];const set=(key,value)=>{group.rows[0][group.columns.findIndex(p=>p[0]===key)]=value;};
 for(const key of ['value','valueUsd','sourceReportedValue','shares'])set(key,0);set('sourceValue','');set('sourceShares','');set('rawSource',{shares:'',rawValue:'',putCall:null});
 for(const item of f.coverage.labels.filter(x=>x.cik===f.rows[0].cik))item.valueUsd=0;f.manifest.totalEquityValueUsd-=900;f.rebuild();await assert.rejects(loader.load(f.options),/source numeric reconciliation/);
});
test('source equity hook does not infer fund status from ticker, CUSIP alone or missing option flags',()=>{
 for(const bad of [
  {cusip:'25459Y207',name:'Different issuer',titleOfClass:'NASDAQ100 EQ WT'},
  {cusip:'88636J410',name:'Different issuer',titleOfClass:'PEERLESS OPTION'},
  {cusip:'000000000',name:'TIDAL TRUST II',titleOfClass:'PEERLESS OPTION'},
  {cusip:'88636J410',name:'TIDAL TRUST II',titleOfClass:'PEERLESS OPTION WARRANT'},
  {cusip:'88636J410',name:'TIDAL TRUST II',titleOfClass:'PEERLESS OPTION',putCall:'CALL'},
  {cusip:'25459Y207',name:'DIREXION SHARES ETF TRUST',titleOfClass:'NASDAQ100 EQ WT',isOption:true},
  {cusip:'25459Y207',name:'DIREXION SHARES ETF TRUST',titleOfClass:'NASDAQ100 EQ WT',shareType:'PRN'},
  {name:'Plain shares',titleOfClass:'COM',putCall:undefined}
 ]) assert.equal(loader.isReportedEquity(row(bad)),false);
});
test('equity overrides require exact identity and cannot override option flags, principal units or warrants',()=>{
 const override={cusip:'123456789',issuer:'SYNTHETIC TEST FUND',titleOfClass:'TEST OPTION',classification:'fund_share',evidence:[{url:'https://example.com/test-only',sha256:'a'.repeat(64),title:'Synthetic fixture only',checkedAt:'2026-11-05T00:00:00Z'}]};
 loader.validateClassificationPolicy([override],Date.parse('2026-11-05T01:00:00Z'));
 const candidate=row({issuer:'Synthetic  Test Fund ',name:'Synthetic Test Fund',titleOfClass:' test OPTION '});
 assert.equal(loader.isReportedEquity(candidate),false);assert.equal(loader.isReportedEquity(candidate,[override]),true);
 for(const change of [{cusip:'987654321'},{issuer:'Different Fund'},{titleOfClass:'OTHER OPTION'},{putCall:'CALL'},{putCall:'PUT'},{shareType:'PRN'},{isOption:true},{optionType:'CALL'},{titleOfClass:'TEST OPTION WARRANT'},{titleOfClass:'WTS'},{name:'Different display issuer'},{rawSource:{}},{rawSource:{putCall:''}}])assert.equal(loader.isReportedEquity({...candidate,...change},[override]),false);
 for(const invalid of [{...override,classification:'unknown'},{...override,evidence:[]},{...override,evidence:[{...override.evidence[0],url:'javascript:alert(1)'}]},{...override,evidence:[{...override.evidence[0],sha256:'bad'}]}])assert.throws(()=>loader.validateClassificationPolicy([invalid],Date.parse('2026-11-05T01:00:00Z')),/classification/);
});
test('reviewed official ETF tuples admit shares, never same-identity Citadel calls or puts',()=>{
 const scope=JSON.parse(fs.readFileSync(path.join(__dirname,'../partial_display_scope.json'))),rules=scope.equityShareClassOverrides;
 assert.equal(rules.length,2);loader.validateClassificationPolicy(rules,Date.parse('2026-11-05T23:00:00Z'));
 for(const rule of rules){const source=row({cusip:rule.cusip,issuer:rule.issuer,name:rule.issuer,titleOfClass:rule.titleOfClass});assert.equal(loader.isReportedEquity(source,rules),true);assert.equal(loader.isReportedEquity({...source,cusip:source.cusip.toLowerCase()},rules),true);for(const wrong of [{issuer:'OTHER'},{name:'OTHER'},{titleOfClass:rule.titleOfClass+' OTHER'},{cusip:'000000000'},{rawSource:{putCall:''}},{rawSource:{}}])assert.equal(loader.isReportedEquity({...source,...wrong},rules),false);}
 const qqqe=rules.find(x=>x.cusip==='25459Y207');
 for(const [putCall,value] of [['CALL',10285443],['PUT',744261]])assert.equal(loader.isReportedEquity(row({cusip:qqqe.cusip,issuer:qqqe.issuer,name:qqqe.issuer,titleOfClass:qqqe.titleOfClass,putCall,value,rawSource:{putCall}}),rules),false);
});
test('complete position partition is required, safe, resolved and reconciled to equity projection',async()=>{
 for(const mode of ['missing','scope','unresolved','equityCount','fundValue','unsafe']){
  const f=transportFixture();const p=f.manifest.positionClassification;
  if(mode==='missing')delete p.option;if(mode==='scope')f.manifest.positionClassificationScope='all_managers';if(mode==='unresolved')p.unresolved_share_class={rowCount:1,reportedValueUsd:1};if(mode==='equityCount')p.equity.rowCount--;if(mode==='fundValue')p.equity_verified_fund_share={rowCount:1,reportedValueUsd:1};if(mode==='unsafe')p.principal.reportedValueUsd=Number.MAX_SAFE_INTEGER+1;
  f.rebuild();await assert.rejects(loader.load(f.options),/position|classification/);
 }
});
