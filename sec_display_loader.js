/* Static, same-origin, fail-closed partial SEC display loader. */
(function(root) {
  'use strict';
  const CONTRACT = 'exact_43_labels_42_entities_of_50';
  const HEX = /^[a-f0-9]{64}$/;
  const LIMITS = { pointer: 4096, policy: 262144, descriptor: 16384, projection: 16 * 1024 * 1024, manifest: 1024 * 1024, coverage: 1024 * 1024, comparisons: 2 * 1024 * 1024 };
  const fail = message => { throw new Error('SEC partial display unavailable: ' + message); };
  const check = (condition, message) => { if (!condition) fail(message); };
  const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  function safeURL(base, path) {
    check(typeof path === 'string' && /^[A-Za-z0-9_./-]+$/.test(path) && !path.startsWith('/') && !path.split('/').some(x => x === '..' || x === '.' || x === ''), 'unsafe artifact path');
    const url = new URL(path, base);
    check(url.origin === base.origin && url.pathname.startsWith(base.pathname), 'cross-origin artifact');
    return url;
  }
  async function bytes(fetcher, url, limit, expected) {
    const response = await fetcher(url.href, { cache: 'no-store', redirect: 'error', credentials: 'same-origin' });
    check(response && response.ok && !response.redirected && (!response.url || response.url === url.href), 'missing or redirected artifact');
    const length = response.headers?.get('content-length');
    if (length != null) check(/^\d+$/.test(length) && Number(length) <= limit, 'artifact exceeds byte budget');
    check(response.body && typeof response.body.getReader === 'function', 'bounded streaming unavailable');
    const reader = response.body.getReader(); const chunks = []; let total = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        check(part.value instanceof Uint8Array, 'invalid response bytes');
        total += part.value.byteLength;
        if (total > limit || (expected != null && total > expected)) { await reader.cancel(); fail('artifact exceeds byte budget'); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    check(expected == null || total === expected, 'artifact byte length mismatch');
    const result = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }
  async function digest(crypto, data) {
    check(crypto?.subtle, 'WebCrypto unavailable');
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data))).map(x => x.toString(16).padStart(2,'0')).join('');
  }
  function parse(data) {
    try { return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(data)); }
    catch (_) { fail('invalid JSON'); }
  }
  function decode(projection) {
    check(projection?.schemaVersion === 1 && projection.format === 'lossless_grouped_rows_v1' && integer(projection.rowCount) && projection.rowCount <= 200000 && Array.isArray(projection.groups), 'projection schema');
    const rows = [];
    for (const group of projection.groups) {
      check(Array.isArray(group.common) && Array.isArray(group.columns) && group.columns.length <= 128 && group.common.length <= 128 && Array.isArray(group.rows), 'projection group');
      const paths = [...group.common.map(pair => {check(Array.isArray(pair) && pair.length === 2, 'common field'); return pair[0];}), ...group.columns];
      const seen = [];
      for (const path of paths) {
        check(Array.isArray(path) && path.length > 0 && path.length <= 8 && path.every(key => typeof key === 'string' && key.length > 0 && !['__proto__','prototype','constructor'].includes(key)), 'unsafe projection path');
        check(!seen.some(previous => previous.slice(0,Math.min(path.length,previous.length)).every((key,i)=>key === path[i])), 'duplicate or conflicting projection path');
        seen.push(path);
      }
      for (const values of group.rows) {
        check(Array.isArray(values) && values.length === group.columns.length, 'row width');
        const row = {};
        const assign = (path, value) => {
          let cursor = row;
          for (let i = 0; i < path.length - 1; i++) cursor = cursor[path[i]] ||= {};
          const type = typeof value;
          cursor[path.at(-1)] = value === null || type === 'string' || type === 'number' || type === 'boolean'
            ? value : structuredClone(value);
        };
        group.common.forEach(([path,value]) => assign(path, value));
        group.columns.forEach((path,i) => assign(path, values[i]));
        rows.push(row); check(rows.length <= projection.rowCount, 'excess rows');
      }
    }
    check(rows.length === projection.rowCount, 'row count mismatch');
    return rows;
  }
  function validateClassificationPolicy(overrides, now) {
    check(Array.isArray(overrides) && overrides.length <= 16, 'classification policy');
    const seen = new Set();
    for (const item of overrides) {
      check(item && Object.keys(item).sort().join(',') === 'classification,cusip,evidence,issuer,titleOfClass' && /^[A-Za-z0-9*@#]{9}$/.test(item.cusip) && typeof item.issuer === 'string' && item.issuer.trim() && typeof item.titleOfClass === 'string' && item.titleOfClass.trim() && item.classification === 'fund_share' && Array.isArray(item.evidence) && item.evidence.length > 0, 'classification override shape');
      const identity = item.cusip.toUpperCase();
      check(!seen.has(identity), 'duplicate classification override'); seen.add(identity);
      for (const proof of item.evidence) {
        check(proof && Object.keys(proof).sort().join(',') === 'checkedAt,sha256,title,url', 'classification evidence shape');
        let url; try { url = new URL(proof.url); } catch (_) { fail('classification evidence URL'); }
        check(url.protocol === 'https:' && !url.username && !url.password && !url.port && HEX.test(proof.sha256) && typeof proof.title === 'string' && proof.title.trim() && typeof proof.checkedAt === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(proof.checkedAt) && Number.isFinite(Date.parse(proof.checkedAt)) && Date.parse(proof.checkedAt) <= now, 'classification evidence');
      }
    }
  }
  function canonicalSourceText(value) { return String(value || '').trim().replace(/\s+/g, ' ').toUpperCase(); }
  function matchesReviewedFundShare(row, overrides) {
    const title = canonicalSourceText(row.titleOfClass);
    return overrides.some(item => item.classification === 'fund_share' && String(row.cusip || '').toUpperCase() === item.cusip.toUpperCase() && row.rawSource && Object.prototype.hasOwnProperty.call(row.rawSource, 'putCall') && row.rawSource.putCall === null && canonicalSourceText(row.issuer) === canonicalSourceText(item.issuer) && canonicalSourceText(row.name) === canonicalSourceText(item.issuer) && title === canonicalSourceText(item.titleOfClass));
  }
  function isReportedEquity(row, overrides = []) {
    if (!row || row.shareType !== 'SH' || row.putCall !== '' || row.isOption === true || row.optionType) return false;
    const title = canonicalSourceText(row.titleOfClass);
    if (/\b(?:WARRANTS?|WTS)\b/.test(title)) return false;
    const exception = matchesReviewedFundShare(row, overrides);
    return exception || !/\b(?:WARRANTS?|WTS?|OPTIONS?|CALLS?|PUTS?)\b/.test(title);
  }
  function validate(rows, coverage, manifest, policy, scope, now) {
    validateClassificationPolicy(policy.equityShareClassOverrides || [], now);
    check(policy.contract === CONTRACT && policy.schemaVersion === 1 && Array.isArray(policy.originalLabels) && new Set(policy.originalLabels).size === 50 && policy.originalLabels.length === 50 && policy.eligible?.length === 43 && policy.pending?.length === 7, 'scope policy');
    check(manifest.schemaVersion === 3 && manifest.contract === CONTRACT && manifest.scopeSha256 === scope && manifest.partialDisplayEligible === true && manifest.releaseEligible === false && manifest.migrationReady === false, 'manifest eligibility');
    for (const [key,expected] of Object.entries({originalLabelCount:50,availableLabelCount:43,availableEntityCount:42,pendingLabelCount:7})) check(manifest[key] === expected, 'manifest counts');
    check(coverage.schemaVersion === 1 && coverage.contract === CONTRACT && Array.isArray(coverage.labels) && coverage.labels.length === 50, 'coverage schema');
    for (const [key,expected] of Object.entries({originalLabels:50,availableLabels:43,availableEntities:42,pendingLabels:7})) check(coverage.counts?.[key] === expected, 'coverage counts');
    const eligible = new Map(policy.eligible.map(item => [item.label,item]));
    const pending = new Map(policy.pending.map(item => [item.label,item]));
    const entities = new Map(); const labels = new Set();
    for (const item of coverage.labels) {
      check(policy.originalLabels.includes(item.label) && !labels.has(item.label), 'coverage label'); labels.add(item.label);
      const rule = eligible.get(item.label) || pending.get(item.label);
      check(rule && item.cik === rule.cik, 'scope identity');
      if (eligible.has(item.label)) {
        check(item.status === 'available' && item.legalName === rule.legalName && item.entityId === item.cik && date(item.reportDate) && integer(item.valueUsd) && integer(item.holdingsCount), 'available coverage');
        check(!entities.has(item.cik) || entities.get(item.cik).legalName === item.legalName, 'alias identity mismatch');
        entities.set(item.cik,item);
      } else {
        check(item.status === 'verification-pending' && item.valueUsd === null && item.holdingsCount === null && item.reportDate === null && item.entityId === null && item.reason === rule.reason, 'pending numeric data');
      }
    }
    check(entities.size === 42 && labels.size === 50, 'exact scope count');
    check(Array.isArray(manifest.sources) && manifest.sources.length > 0, 'source list');
    const sources = new Map();
    const official = (url,cik,accession) => typeof url === 'string' && url.startsWith(`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g,'')}/`) && !/[?#]/.test(url) && !url.includes('..');
    for (const source of manifest.sources) {
      check(HEX.test(source.tableSha256) && HEX.test(source.primarySha256) && entities.get(source.cik)?.legalName === source.legalName && date(source.period) && date(source.filingDate) && Date.parse(source.filingDate) <= now && Date.parse(source.period) <= Date.parse(source.filingDate) && /^\d{10}-\d{2}-\d{6}$/.test(source.accession) && official(source.sourceUrl,source.cik,source.accession) && official(source.primarySourceUrl,source.cik,source.accession), 'source descriptor');
      check(!sources.has(source.cik+':'+source.accession), 'duplicate source'); sources.set(source.cik+':'+source.accession,source);
    }
    const seen = new Set(), totals = new Map(); let total = 0;
    for (const row of rows) {
      const entity = entities.get(row.cik), source = sources.get(row.cik+':'+row.accession);
      check(entity && row.legalName === entity.legalName && source && row.period === source.period && row.period === entity.reportDate && row.filingDate === source.filingDate && row.tableSha256 === source.tableSha256 && row.primarySha256 === source.primarySha256 && row.sourceUrl === source.sourceUrl && row.primarySourceUrl === source.primarySourceUrl, 'row source binding');
      check(isReportedEquity(row, policy.equityShareClassOverrides || []) && integer(row.shares) && integer(row.value) && row.valueUnit === 'USD', 'non-equity or invalid numeric row');
      check(row.valueUsd === row.value && integer(row.sourceReportedValue) && row.valueMultiplier === (row.filingDate >= '2023-01-03' ? 1 : 1000) && row.sourceReportedValue * row.valueMultiplier === row.value && row.sourceValueUnit === (row.valueMultiplier === 1 ? 'USD' : 'THOUSANDS_USD') && typeof row.sourceValue === 'string' && /^[0-9]+$/.test(row.sourceValue.trim()) && Number(row.sourceValue) === row.sourceReportedValue && typeof row.sourceShares === 'string' && /^[0-9]+$/.test(row.sourceShares.trim()) && Number(row.sourceShares) === row.shares && row.rawSource && Object.prototype.hasOwnProperty.call(row.rawSource, 'putCall') && row.rawSource.putCall === null && typeof row.rawSource.shares === 'string' && /^[0-9]+$/.test(row.rawSource.shares.trim()) && typeof row.rawSource.rawValue === 'string' && /^[0-9]+$/.test(row.rawSource.rawValue.trim()) && Number(row.rawSource.shares) === row.shares && Number(row.rawSource.rawValue) === row.sourceReportedValue, 'source numeric reconciliation');
      check(row.schemaVersion === 3 && row.verificationStatus === 'source_reconciled' && row.managerIdentityStatus === 'verified' && row.action === 'UNKNOWN' && HEX.test(row.tableSha256) && HEX.test(row.primarySha256) && typeof row.sourceRowId === 'string' && row.sourceRowId === `${row.accession}:${row.tableSha256}:${row.sourceRow}` && integer(row.sourceRow) && row.sourceRow > 0 && !seen.has(row.sourceRowId), 'row provenance');
      check(typeof row.cusip === 'string' && /^[A-Za-z0-9*@#]{9}$/.test(row.cusip) && typeof row.name === 'string' && row.name.length > 0 && typeof row.titleOfClass === 'string' && row.titleOfClass.length > 0, 'security identity');
      seen.add(row.sourceRowId); total += row.value; check(integer(total), 'unsafe aggregate');
      const subtotal = totals.get(row.cik) || {count:0,value:0}; subtotal.count++; subtotal.value += row.value; totals.set(row.cik,subtotal);
    }
    check(Array.isArray(manifest.sourceReportDates) && JSON.stringify([...new Set(coverage.labels.filter(item => item.status === 'available').map(item => item.reportDate))].sort()) === JSON.stringify(manifest.sourceReportDates), 'source period summary');
    check(rows.length === manifest.holdingsRowCount && total === manifest.totalEquityValueUsd, 'manifest reconciliation');
    const kinds = ['equity','equity_verified_fund_share','option','principal','warrant','unresolved_share_class'];
    const partition = manifest.positionClassification;
    check(manifest.positionClassificationScope === 'available_reporting_entities' && partition && Object.keys(partition).sort().join(',') === kinds.slice().sort().join(','), 'position classification scope');
    let partitionCount = 0, partitionValue = 0;
    for (const kind of kinds) {
      const item = partition[kind];
      check(item && integer(item.rowCount) && integer(item.reportedValueUsd) && (item.rowCount > 0 || item.reportedValueUsd === 0), 'position classification numeric data');
      partitionCount += item.rowCount; partitionValue += item.reportedValueUsd;
      check(integer(partitionCount) && integer(partitionValue), 'unsafe position partition');
    }
    check(partition.unresolved_share_class.rowCount === 0 && partition.unresolved_share_class.reportedValueUsd === 0, 'unresolved source positions');
    const reviewedRows = rows.filter(row => matchesReviewedFundShare(row, policy.equityShareClassOverrides || []));
    const reviewedValue = reviewedRows.reduce((sum,row) => sum+row.value,0);
    check(partition.equity_verified_fund_share.rowCount === reviewedRows.length && partition.equity_verified_fund_share.reportedValueUsd === reviewedValue && partition.equity.rowCount === rows.length-reviewedRows.length && partition.equity.reportedValueUsd === total-reviewedValue, 'position classification reconciliation');

    for (const item of coverage.labels.filter(x=>x.status === 'available')) {
      const subtotal = totals.get(item.cik) || {count:0,value:0};
      check(subtotal.count === item.holdingsCount && subtotal.value === item.valueUsd, 'coverage reconciliation');
    }
    const times = {};
    for (const key of ['lastChecked','preparedAt','acquisitionStartedAt']) {
      check(typeof manifest[key] === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(manifest[key]), 'undated verification');
      times[key] = Date.parse(manifest[key]); check(Number.isFinite(times[key]) && times[key] <= now, 'future or invalid verification timestamp');
    }
    check(times.acquisitionStartedAt <= times.lastChecked && times.lastChecked <= times.preparedAt, 'verification timestamp order');
    const ageHours = (now-times.acquisitionStartedAt)/3600000;
    return {loadedAt:new Date(now).toISOString(),lastCheckedAt:manifest.lastChecked,acquisitionStartedAt:manifest.acquisitionStartedAt,ageHours,stale:ageHours>24,label:ageHours>24?'불러온 시점 기준 오래된 확인 · 과거 공시 스냅샷':'불러온 시점 기준 24시간 이내 확인 · 과거 공시 스냅샷'};
  }
  function validateComparisons(payload, generation, rows, now) {
    check(payload?.schemaVersion === 1 && payload.generationId === generation && Array.isArray(payload.managers), 'comparison generation');
    const current = new Map();
    for (const row of rows) {
      if (!current.has(row.cik)) current.set(row.cik, {period: row.period, positions: new Set()});
      current.get(row.cik).positions.add(row.cusip.toUpperCase());
    }
    const comparisons = new Map();
    for (const item of payload.managers) {
      const entity = current.get(item.cik);
      check(entity && entity.period === item.period && !comparisons.has(item.cik), 'comparison reporting entity');
      const currentDate = new Date(item.period);
      const previous = new Date(Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth() - 2, 0));
      check(previous.toISOString().slice(0, 10) === item.previousPeriod, 'comparison quarter');
      check(Array.isArray(item.sources) && item.sources.length > 0 && item.sources.length <= 100 && item.sources.every(source => {
        if (!/^\d{10}-\d{2}-\d{6}$/.test(source.accession) || !date(source.filingDate) ||
            source.filingDate < item.previousPeriod || Date.parse(source.filingDate) > now) return false;
        const prefix = `https://www.sec.gov/Archives/edgar/data/${Number(item.cik)}/${source.accession.replace(/-/g, '')}/`;
        return typeof source.sourceUrl === 'string' && source.sourceUrl.startsWith(prefix) &&
          /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.xml$/i.test(source.sourceUrl.slice(prefix.length)) && !source.sourceUrl.includes('..');
      }), 'comparison sources');
      check(Array.isArray(item.positions) && item.positions.length > 0 && item.positions.length <= entity.positions.size, 'comparison positions');
      const positions = new Map();
      for (const pair of item.positions) {
        check(Array.isArray(pair) && pair.length === 2 && entity.positions.has(pair[0]) && !positions.has(pair[0]) &&
          (pair[1] === null || integer(pair[1])), 'comparison security identity or shares');
        positions.set(pair[0], pair[1]);
      }
      comparisons.set(item.cik, {previousPeriod: item.previousPeriod, sources: item.sources, positions});
    }
    return comparisons;
  }
  async function load(options = {}) {
    const config = options.config || root.SEC_DISPLAY_CONFIG;
    const base = new URL(options.baseURL || './', root.document?.baseURI);
    check(base.protocol === 'https:' || base.protocol === 'http:', 'unsupported origin');
    check(base.pathname.endsWith('/') && !base.search && !base.hash, 'invalid base directory');
    check(config?.contract === CONTRACT && HEX.test(config.expectedScopeSha256), 'bootstrap config');
    const fetcher = options.fetch || root.fetch.bind(root), crypto = options.crypto || root.crypto;
    const readNow = () => typeof options.now === 'function' ? options.now() : options.now ?? Date.now();
    const now = readNow();
    check(Number.isFinite(now), 'clock unavailable');
    const policyURL = safeURL(base,config.policyPath), pointerURL = safeURL(base,config.pointerPath);
    const [policyBefore, pointerBytes] = await Promise.all([
      bytes(fetcher, policyURL, LIMITS.policy),
      bytes(fetcher, pointerURL, LIMITS.pointer)
    ]);
    check(await digest(crypto,policyBefore) === config.expectedScopeSha256, 'policy revoked or changed');
    const policy = parse(policyBefore);
    const pointer = parse(pointerBytes);
    check(pointer.schemaVersion === 1 && pointer.contract === CONTRACT && HEX.test(pointer.generationId), 'pointer schema');
    const generationBase = new URL(`generations/${pointer.generationId}/`, new URL('./',pointerURL));
    const descriptorBytes = await bytes(fetcher,safeURL(generationBase,'generation.json'),LIMITS.descriptor);
    check(await digest(crypto,descriptorBytes) === pointer.generationId, 'generation hash mismatch');
    const descriptor = parse(descriptorBytes);
    check(descriptor.schemaVersion === 1 && descriptor.artifactType === 'sec_13f_partial_pages_generation' && descriptor.scopeSha256 === config.expectedScopeSha256, 'generation schema');
    check(descriptor.files && Object.keys(descriptor.files).sort().join(',') === 'coverage.json,manifest.json,projection.json', 'unexpected generation files');
    const artifacts = ['projection', 'manifest', 'coverage'].map(kind => {
      const name = kind + '.json';
      const ref = descriptor.files[name], limit = LIMITS[kind];
      check(ref && HEX.test(ref.sha256) && integer(ref.bytes) && ref.bytes > 0 && ref.bytes <= limit, 'artifact reference or budget');
      return { ref, limit, url: safeURL(generationBase, name) };
    });
    const [projection, manifest, coverage] = await Promise.all(artifacts.map(async ({ ref, limit, url }) => {
      const data = await bytes(fetcher, url, limit, ref.bytes);
      check(await digest(crypto,data) === ref.sha256, 'artifact hash mismatch');
      return parse(data);
    }));
    const rows = decode(projection);
    const policyAfter = await bytes(fetcher,policyURL,LIMITS.policy);
    check(await digest(crypto,policyAfter) === config.expectedScopeSha256, 'policy revoked during load');
    const finalNow = readNow(); check(Number.isFinite(finalNow), 'clock unavailable');
    const freshness = validate(rows,coverage,manifest,policy,config.expectedScopeSha256,finalNow);
    let comparisons = null;
    const comparisonHash = pointer.comparisonSha256 ?? config.comparisonSha256;
    if (HEX.test(comparisonHash || '')) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const url = pointer.comparisonSha256
          ? safeURL(generationBase, 'holding-comparisons.json')
          : safeURL(base, 'sec-data/holding-comparisons.json');
        const data = await bytes((url, options) => fetcher(url, {...options, signal: controller.signal}), url, LIMITS.comparisons);
        check(await digest(crypto, data) === comparisonHash, 'comparison hash mismatch');
        comparisons = validateComparisons(parse(data), pointer.generationId, rows, finalNow);
      } catch (_) {
        // Preserve the verified current snapshot when the optional comparison is unavailable.
      } finally { clearTimeout(timer); }
    }
    return {rows,coverage,manifest,classificationPolicy:policy.equityShareClassOverrides || [],sources:manifest.sources,freshness,generation:pointer.generationId,comparisons};
  }
  const api = {load,decode,validate,validateComparisons,isReportedEquity,validateClassificationPolicy,LIMITS};
  root.SECDisplayLoader = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
