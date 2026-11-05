function safeSecUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && ['www.sec.gov', 'sec.gov'].includes(url.hostname) && !url.username && !url.password && !url.port ? url.href : '#';
  } catch (_) { return '#'; }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}

/**
 * ==============================================================================
 * Alpha13F - 100대 운용사 포트폴리오 인텔리전스 (프론트엔드 분석 엔진)
 * ==============================================================================
 */

let GURU_DATABASE = {};
let RAW_HOLDINGS = [];
let SEC_DISPLAY = null;
let SEC_DISPLAY_ROWS = new WeakSet();
let LIVE_PRICES = {};
let ACTIVE_STOCK_ITEM = null;
let ACTIVE_STOCK_GURU_KEY = null;

// Firebase 설정 & 클라우드 동기화 엔진
const firebaseConfig = {
  apiKey: "AIzaSyBCxnvGWZBXtJKwvsaSs2P2xCOVa82tXvg",
  authDomain: "alpha13f-e9be4.firebaseapp.com",
  projectId: "alpha13f-e9be4",
  storageBucket: "alpha13f-e9be4.firebasestorage.app",
  messagingSenderId: "940351126278",
  appId: "1:940351126278:web:e2ec48dd2138c854023c87",
  measurementId: "G-XCGQPV83D8"
};

let CURRENT_USER = null;
let db = null;
let auth = null;

function initFirebase() {
  try {
    if (window.firebase) {
      firebase.initializeApp(firebaseConfig);
      auth = firebase.auth();
      db = firebase.firestore();

      auth.onAuthStateChanged(async (user) => {
        CURRENT_USER = user;
        updateAuthUI(user);
        if (user) {
          await syncFavoritesFromCloud(user.uid);
        }
      });
    }
  } catch (e) {
    console.error("Firebase 초기화 에러:", e);
  }
}

function updateAuthUI(user) {
  const btnLogin = document.getElementById("btnGoogleLogin");
  const userProfile = document.getElementById("userProfile");
  const userAvatar = document.getElementById("userAvatar");
  const userName = document.getElementById("userName");
  const btnCustomGroup = document.getElementById("btnCustomGroup");
  const navCustomGroup = document.querySelector('.nav-item[data-tab="custom-group"]');

  if (user) {
    if (btnLogin) btnLogin.style.display = "none";
    if (userProfile) userProfile.style.display = "flex";
    if (userAvatar) userAvatar.src = user.photoURL || "https://www.gstatic.com/images/branding/product/1x/avatar_square_blue_512dp.png";
    if (userName) userName.innerText = user.displayName || user.email.split("@")[0];
    if (btnCustomGroup) btnCustomGroup.style.display = "block";
    if (navCustomGroup) navCustomGroup.style.display = "flex";
  } else {
    if (btnLogin) btnLogin.style.display = "inline-flex";
    if (userProfile) userProfile.style.display = "none";
    if (btnCustomGroup) btnCustomGroup.style.display = "none";
    if (navCustomGroup) navCustomGroup.style.display = "none";

    if (state.currentGuruKey === "__CUSTOM_GROUP__") {
      selectGuru("__GRAND_TOTAL__");
    }
    if (state.activeCategory === "FAV") {
      state.activeCategory = "ALL";
    }
  }

  renderCategoryTabs();
  renderGuruSidebar();
}

async function loginWithGoogle() {
  if (!auth) return;
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    await auth.signInWithPopup(provider);
  } catch (err) {
    console.warn("Popup 로그인 실패, redirect 시도:", err);
    try {
      await auth.signInWithRedirect(provider);
    } catch (e) {
      alert("구글 로그인 중 오류가 발생했습니다: " + e.message);
    }
  }
}

async function logout() {
  if (!auth) return;
  if (unsubscribeFavsListener) {
    unsubscribeFavsListener();
    unsubscribeFavsListener = null;
  }
  await auth.signOut();
  CURRENT_USER = null;
  updateAuthUI(null);
}

let unsubscribeFavsListener = null;

function setupCloudFavoritesListener(uid) {
  if (!db || !uid) return;
  if (unsubscribeFavsListener) {
    unsubscribeFavsListener();
  }

  const docRef = db.collection("users").doc(uid);
  unsubscribeFavsListener = docRef.onSnapshot((doc) => {
    if (doc.exists) {
      const data = doc.data();
      if (data && Array.isArray(data.favorites)) {
        saveFavorites(data.favorites);
        renderCategoryTabs();
        renderGuruSidebar();
        if (state.currentGuruKey === "__CUSTOM_GROUP__") {
          selectGuru("__CUSTOM_GROUP__");
        }
      }
    } else {
      // 최초 사용자의 경우 기본 5대 운용사를 클라우드에 생성
      const initialFavs = ["Warren Buffett", "Bill Ackman", "Ray Dalio", "Michael Burry", "Stanley Druckenmiller"];
      docRef.set({
        favorites: initialFavs,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      saveFavorites(initialFavs);
      renderCategoryTabs();
      renderGuruSidebar();
    }
  }, (err) => {
    console.warn("Firestore 실시간 리스너 에러:", err);
  });
}

async function syncFavoritesFromCloud(uid) {
  setupCloudFavoritesListener(uid);
}

async function syncFavoritesToCloud(favs) {
  if (!db || !CURRENT_USER) return;
  try {
    await db.collection("users").doc(CURRENT_USER.uid).set({
      favorites: favs,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (e) {
    console.warn("클라우드 저장 실패:", e);
  }
}

function getFavorites() {
  if (!CURRENT_USER) return [];
  try {
    const saved = localStorage.getItem(`alpha13f_favs_${CURRENT_USER.uid}`);
    return saved ? JSON.parse(saved) : [];
  } catch (e) {
    return [];
  }
}

function saveFavorites(favs) {
  if (!CURRENT_USER) return;
  try {
    localStorage.setItem(`alpha13f_favs_${CURRENT_USER.uid}`, JSON.stringify(favs));
  } catch (e) {}
}

function toggleFavorite(guruKey) {
  if (!CURRENT_USER) {
    alert("즐겨찾기 기능은 구글 로그인 후 이용하실 수 있습니다.");
    loginWithGoogle();
    return;
  }
  let favs = getFavorites();
  if (favs.includes(guruKey)) {
    favs = favs.filter(k => k !== guruKey);
  } else {
    favs.push(guruKey);
  }
  saveFavorites(favs);
  syncFavoritesToCloud(favs);
  renderCategoryTabs();
  renderGuruSidebar();
}

// 주요 120대 미국 기업 및 ETF 공식 티커 전수 매핑 사전
// Compatibility copy for loading older deployments; never used as identity evidence.
const TICKER_MAP = {};

// 120대 주요 종목 공식 GICS 섹터 매핑 사전 (기능 3)
const SECTOR_MAP = {
  // 정보기술 (Technology)
  "AAPL": "Technology", "MSFT": "Technology", "NVDA": "Technology", "AVGO": "Technology",
  "AMD": "Technology", "QCOM": "Technology", "TXN": "Technology", "CRM": "Technology",
  "ADBE": "Technology", "INTC": "Technology", "ORCL": "Technology", "NOW": "Technology",
  "SNOW": "Technology", "PLTR": "Technology", "PANW": "Technology", "CRWD": "Technology",
  "ANET": "Technology", "MRVL": "Technology", "SNPS": "Technology", "CDNS": "Technology",
  "ADI": "Technology", "KLAC": "Technology", "MCHP": "Technology", "ON": "Technology",
  "MPWR": "Technology", "AMAT": "Technology", "LRCX": "Technology", "APP": "Technology",
  "NET": "Technology", "SMCI": "Technology", "MU": "Technology", "ASML": "Technology",
  "CSCO": "Technology", "INTU": "Technology", "VRSN": "Technology", "SHOP": "Technology",
  // 통신 / 미디어 (Communication)
  "GOOGL": "Communication", "GOOG": "Communication", "META": "Communication", "NFLX": "Communication",
  "DIS": "Communication", "SPOT": "Communication", "CHTR": "Communication", "CMCSA": "Communication",
  "RBLX": "Communication", "DUOL": "Communication",
  // 임의소비재 (Consumer Discretionary)
  "AMZN": "Consumer Discretionary", "TSLA": "Consumer Discretionary", "BKNG": "Consumer Discretionary",
  "ABNB": "Consumer Discretionary", "MELI": "Consumer Discretionary", "SE": "Consumer Discretionary",
  "DKNG": "Consumer Discretionary", "DASH": "Consumer Discretionary", "MODG": "Consumer Discretionary",
  // 필수소비재 (Consumer Staples)
  "KO": "Consumer Staples", "PEP": "Consumer Staples", "PG": "Consumer Staples", "WMT": "Consumer Staples",
  "COST": "Consumer Staples", "KHC": "Consumer Staples",
  // 금융 (Financials)
  "JPM": "Financials", "BAC": "Financials", "WFC": "Financials", "GS": "Financials",
  "AXP": "Financials", "V": "Financials", "MA": "Financials", "SPGI": "Financials",
  "MCO": "Financials", "CB": "Financials", "PYPL": "Financials", "XYZ": "Financials",
  "COIN": "Financials", "HOOD": "Financials", "NU": "Financials", "STT": "Financials",
  "BRK.A": "Financials", "BRK.B": "Financials",
  // 헬스케어 (Healthcare)
  "LLY": "Healthcare", "JNJ": "Healthcare", "UNH": "Healthcare", "NVO": "Healthcare",
  "ISRG": "Healthcare",
  // 에너지 (Energy)
  "CVX": "Energy", "XOM": "Energy", "OXY": "Energy",
  // 산업재 (Industrials)
  "GE": "Industrials", "GEV": "Industrials", "WDC": "Industrials", "STX": "Industrials",
  "UBER": "Industrials", "CSGP": "Industrials",
  // ETF / 지수
  "SPY": "ETF / Index", "IVV": "ETF / Index", "QQQ": "ETF / Index", "IWM": "ETF / Index",
  "GLD": "ETF / Index", "SLV": "ETF / Index", "DIA": "ETF / Index", "EEM": "ETF / Index",
  "IEFA": "ETF / Index", "VOO": "ETF / Index", "VTI": "ETF / Index", "IBIT": "ETF / Index",
  "XLK": "ETF / Index", "XLF": "ETF / Index", "XLE": "ETF / Index", "XLY": "ETF / Index",
  "XLV": "ETF / Index", "AGG": "ETF / Index", "IJR": "ETF / Index", "IJH": "ETF / Index",
  "IWF": "ETF / Index", "EFA": "ETF / Index"
};

const SECTOR_COLORS = {
  "Technology": "#3b82f6", // Blue
  "Communication": "#a855f7", // Purple
  "Financials": "#10b981", // Green
  "Consumer Discretionary": "#f59e0b", // Amber
  "Consumer Staples": "#eab308", // Yellow
  "Healthcare": "#ec4899", // Pink
  "Energy": "#ef4444", // Red
  "Industrials": "#8b5cf6", // Violet
  "ETF / Index": "#06b6d4", // Cyan
  "Other": "#6b7280" // Gray
};

function getMappedSector(ticker, defaultSector) {
  const symbol = canonicalTicker(ticker);
  if (SECTOR_MAP[symbol]) return SECTOR_MAP[symbol];
  if (defaultSector && defaultSector !== "Other" && defaultSector !== "General") return defaultSector;
  return "Other";
}

const TICKER_LOOKUP_CACHE = {};
let MARKET_SYMBOLS = null;

function canonicalTicker(ticker) {
  const symbol = String(ticker || '').toUpperCase().trim();
  return (MARKET_SYMBOLS && MARKET_SYMBOLS.aliases[symbol]) || symbol;
}

function quoteStatus(info, now = Date.now()) {
  if (!info || !hasPrice(info.price)) return 'unavailable';
  if (!Number.isFinite(info.marketTime) || info.marketTime <= 0) return 'undated';
  const age = now / 1000 - info.marketTime;
  if (age < -300) return 'invalid-time';
  // Match the API/collector's conservative 24-hour window. No assumed market calendar.
  if (info.stale === true || age > 24 * 3600) return 'stale';
  return 'fresh';
}

function quoteFields(ticker, info) {
  const symbol = canonicalTicker(ticker);
  const inactive = MARKET_SYMBOLS && MARKET_SYMBOLS.inactive[symbol];
  const status = quoteStatus(info);
  const available = MARKET_SYMBOLS && !inactive && !/^(CUSIP:|UNMAPPED:)/.test(symbol) && status === 'fresh' && info.currency === 'USD';
  let asOf = available ? quoteFreshness(info) : '유효한 최근 시세 없음';
  if (inactive) {
    asOf = `상장폐지 (${inactive.effectiveDate}) · 현재 시세 없음`;
  } else if (!MARKET_SYMBOLS) {
    asOf = '거래 상태 확인 불가 · 현재 시세 없음';
  } else if (status === 'fresh' && info.currency !== 'USD') {
    asOf = 'USD 시세 확인 불가 · 현재 시세 없음';
  }
  if (!available && info && hasPrice(info.price)) {
    const observed = info.currency === 'USD' ? priceLabel(info.price) : `${info.price.toFixed(2)} ${info.currency || '통화 미확인'}`;
    asOf += ` · 마지막 관측 ${observed} · ${quoteFreshness(info)}`;
  }
  return {
    curPrice: available ? info.price : null,
    priceChangePct: available && Number.isFinite(info.changePct) ? info.changePct : null,
    quoteAsOf: asOf,
    quoteMarketTime: info && info.marketTime,
    quoteCurrency: info && info.currency,
    quoteStatus: available ? 'fresh' : status === 'fresh' ? 'unavailable' : status
  };
}

function mergeObservedPrices(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  for (const [rawSymbol, info] of Object.entries(data)) {
    const symbol = canonicalTicker(rawSymbol);
    // Do not revive an obsolete alias cache as the current security's quote.
    if (symbol !== rawSymbol || !info || !hasPrice(info.price)) continue;
    const previous = LIVE_PRICES[symbol];
    const observed = info.marketTime;
    const previousTime = previous && previous.marketTime;
    const validTime = Number.isFinite(observed) && observed > 0 && observed <= Date.now() / 1000 + 300;
    if (Number.isFinite(previousTime) && previousTime > 0 && previousTime <= Date.now() / 1000 + 300) {
      if (!validTime || observed < previousTime) continue;
      // Same observation time with conflicting values is not a newer observation.
      if (observed === previousTime && (info.price !== previous.price || info.currency !== previous.currency)) continue;
    } else if (Number.isFinite(observed) && !validTime) {
      continue;
    }
    LIVE_PRICES[symbol] = info;
  }
}

function getMappedTicker(name, rawTicker, cusip, shareType = 'SH', putCall = null) {
  const id = String(cusip || '').toUpperCase().trim();
  const company = String(name || '').trim();
  const unresolved = id ? `CUSIP:${id}` : `UNMAPPED:${company || rawTicker || 'UNKNOWN'}`;
  // Neither issuer names, inherited tickers nor the old map establish identity.
  // Missing metadata, unreviewed CUSIPs and non-equity instruments fail closed.
  if (!id || !MARKET_SYMBOLS || String(shareType || 'SH').toUpperCase() !== 'SH' || putCall) return unresolved;
  if (MARKET_SYMBOLS.nonEquityCusips[id] || MARKET_SYMBOLS.quarantinedCusips[id]) return unresolved;
  const reviewed = MARKET_SYMBOLS.reviewedCusips[id];
  if (!reviewed || !reviewed.sourceUrl || reviewed.quoteEligible === false) return unresolved;
  const ticker = canonicalTicker(reviewed.ticker);
  return /^[A-Z]{1,5}(?:[.-][A-Z])?$/.test(ticker) ? ticker : unresolved;
}

function holdingIdentity(item, fallback = '') {
  const cusip = String(item.cusip || '').toUpperCase().trim();
  const shareType = String(item.shareType || 'SH').toUpperCase().trim();
  const option = String(item.putCall || item.optionType || '').toUpperCase().trim();
  // A symbol identifies a quote, not a security. Never coalesce absent identities.
  return cusip ? `CUSIP:${cusip}|${shareType}|${option || 'EQUITY'}` : item.securityId || `UNIDENTIFIED:${fallback}`;
}

function portfolioFreshness(guru) {
  if (guru.periodRange) {
    return `보유 기준일 ${guru.periodRange[0]} ~ ${guru.periodRange[1]}${guru.periodRange[0] !== guru.periodRange[1] ? ' · 서로 다른 분기 공시 합산' : ''}`;
  }
  const period = guru.periodDate || '미확인';
  const filing = guru.filingDate || '미확인';
  const older = guru.periodDate && guru.latestDatasetPeriod && guru.periodDate < guru.latestDatasetPeriod;
  return `보유 기준일 ${period} · 공시일 ${filing}${older ? ' · 이전 분기 자료 (수집된 최신 기준일보다 오래됨)' : ''}`;
}

function hasPrice(value) { return Number.isFinite(value) && value > 0; }
function priceLabel(value) { return hasPrice(value) ? `$${value.toFixed(2)}` : '시세 없음'; }
function priceComparisonReason(item) {
  if (item.isOption || item.action === 'PUT' || item.action === 'CALL') return '옵션 파생상품 · 비교 제외';
  if (!hasPrice(item.curPrice) || item.quoteStatus !== 'fresh' || quoteStatus({ price: item.curPrice, marketTime: item.quoteMarketTime }) !== 'fresh') return '유효한 최근 시세 없음 · 비교 불가';
  if (item.quoteCurrency !== 'USD') return '통화 확인 불가 · 비교 보류';
  if (!hasPrice(item.estPrice)) return '공시 평가단가 없음 · 비교 불가';
  if (item.periodRange && item.periodRange[0] !== item.periodRange[1]) return '서로 다른 분기 합산 · 비교 보류';
  // Raw SEC value/shares is not a split-adjusted quote. The current pipeline has
  // no verified corporate-action history, so do not turn a split into a discount.
  return '주식분할 등 자본변동 조정 미확인 · 비교 보류';
}
function priceDifference(item) {
  // Intentionally withheld until a sourced corporate-action adjustment pipeline
  // can prove that the filing value and quote use the same per-share basis.
  return NaN;
}

function normalizeMacroData(data) {
  if (data && data.schemaVersion === 2) return data;
  return { schemaVersion: 2, status: 'unavailable', legacyRejected: true,
    sources: {}, calendar: [], timeSeries: { treasuryDaily: [] } };
}
function macroFreshness(data) {
  if (!data || data.legacyRejected) return '출처 검증 전 데이터 · 표시 보류';
  const statuses = { success: '수집 완료', partial: '일부 수집 실패', stale: '오래된 관측값 포함', unavailable: '데이터 확인 불가' };
  const sources = Object.values(data.sources || {});
  const stale = sources.some(s => s.status === 'stale');
  const dates = sources.map(s => s.asOf).filter(d => /^\d{4}-\d{2}-\d{2}/.test(d || '')).map(d => d.slice(0, 10)).sort();
  return `${statuses[data.status] || '수집 상태 미확인'}${stale ? ' · 오래된 관측값 포함' : ''}${dates.length ? ` · 관측일 ${dates[0]} ~ ${dates[dates.length - 1]}` : ' · 관측일 미확인'}`;
}
function quoteFreshness(info) {
  if (!info || !Number.isFinite(info.marketTime) || info.marketTime <= 0) return '시세 관측시각 미확인';
  const time = new Date(info.marketTime * 1000);
  if (!Number.isFinite(time.getTime())) return '시세 관측시각 미확인';
  const age = Date.now() / 1000 - info.marketTime;
  const prefix = age < -300 ? '미래 관측시각 오류 · ' : info.stale === true || age > 24 * 3600 ? '과거 시세 · ' : '';
  return `${prefix}${time.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

function insiderCode(item) {
  return String(item.txTypeCode || item.transactionCode || item.transactionType || '').toUpperCase();
}
function insiderLabel(item) {
  const labels = { P: '장내 매수 (P)', S: '장내 매도 (S)', A: '보상 취득 (A)',
    M: '옵션 행사 (M)', C: '전환 (C)', G: '증여 (G)', F: '세금 납부 (F)' };
  return labels[insiderCode(item)] || '기타 / 유형 미확인';
}
let priceRequestId = 0;
let insiderRequestId = 0;

function formatMoney(val) {
  if (!val || val <= 0) return "$0";
  const actualUsd = Number(val);
  if (actualUsd >= 1e12) {
    return `$${(actualUsd / 1e12).toFixed(2)}T`;
  } else if (actualUsd >= 1e9) {
    return `$${(actualUsd / 1e9).toFixed(2)}B`;
  } else if (actualUsd >= 1e6) {
    return `$${(actualUsd / 1e6).toFixed(1)}M`;
  } else if (actualUsd >= 1e3) {
    return `$${(actualUsd / 1e3).toFixed(1)}K`;
  } else {
    return `$${actualUsd.toFixed(0)}`;
  }
}

function isDerivativeOrOption(name, ticker, titleOfClass, holding = {}) {
  // Instrument fields, not issuer wording: a bond ETF or Option Care Health
  // still represents equity shares and must not silently disappear from AUM.
  if (holding.isOption || holding.putCall || holding.optionType) return true;
  const shareType = String(holding.shareType || '').toUpperCase().trim();
  if (shareType && shareType !== 'SH') return true;
  const securityClass = String(holding.securityClass || titleOfClass || '').toUpperCase();
  const rawTicker = String(ticker || '').toUpperCase();
  if (/(?:[ /-]|^)(PUT|CALL)$/.test(rawTicker)) return true;
  if (/\b(?:PUT|CALL|WARRANT|WARRANTS|WTS)\b/.test(securityClass)) return true;
  if (/\b(?:ETF|FUND|TRUST)\b/.test(securityClass)) return false;
  return /\b(?:PRN|NOTE|NOTES|BOND|BONDS|DEBENTURE)\b/.test(securityClass);
}

const state = {
  currentGuruKey: "__GRAND_TOTAL__",
  activeCategory: "ALL",
  activeFilter: "ALL",
  searchQuery: "",
  sortColumn: "weight",
  sortDirection: "desc",
  visibleColumns: {
    sector: true,
    holders: true,
    shares: true,
    value: true,
    weight: true,
    estPrice: true,
    curPrice: true,
    discount: true
  }
};

document.addEventListener("DOMContentLoaded", () => {
  initFirebase();
  setupEventListeners();
  initMobileInteractions();
  initFilingDdayCountdown();
  initConsensusTabs();
  loadRealSecData();

  // 1분마다 조용히 최신 실시간 시장가 백그라운드 갱신
  setInterval(() => {
    fetchLivePricesForCurrentView();
  }, 60000);
});

// 브라우저에서 현재 화면 종목들의 실시간 주가 및 거시경제 지표 온디맨드 조회 (1분 주기 갱신)
async function refreshMacroSnapshot(requestId) {
  const res = await fetch("latest_macro_indicators.json?_t=" + Date.now()).catch(() => null);
  if (!res || !res.ok) return;
  const data = await res.json().catch(() => null);
  if (!data || requestId !== priceRequestId) return;
  MACRO_DATA = normalizeMacroData(data);
  // All macro surfaces redraw from the same complete snapshot.
  await loadAndRenderMacro();
}

async function refreshMarketSymbols(requestId) {
  const res = await fetch("market_symbols.json?_t=" + Date.now()).catch(() => null);
  if (!res || !res.ok) return false;
  const symbols = await res.json().catch(() => null);
  if (requestId !== priceRequestId) return false;
  if (!symbols || !symbols.aliases || !symbols.inactive || !symbols.nonEquityCusips || !symbols.reviewedCusips || !symbols.quarantinedCusips) return false;
  MARKET_SYMBOLS = symbols;
  return true;
}

async function fetchLivePricesForCurrentView() {
  const requestId = ++priceRequestId;
  // Age retained quotes before any network wait, including a hung upstream.
  refreshVisibleQuotes();
  if (!MARKET_SYMBOLS) {
    if (await refreshMarketSymbols(requestId)) processAndRenderHoldingsData(true);
    if (requestId !== priceRequestId) return;
  }
  const guruKey = state.currentGuruKey;
  const guru = GURU_DATABASE[guruKey];
  const stockTickers = (guru && guru.holdings) 
    ? guru.holdings.slice(0, 30).map(h => h.baseTicker || h.ticker).filter(t => t && t.length <= 5 && !t.includes(" ")).join(",")
    : "";

  const macroTickers = "^TNX,^IRX,^FVX,CL=F,GC=F,DX-Y.NYB";
  const allTickers = stockTickers ? `${stockTickers},${macroTickers}` : macroTickers;

  try {
    const res = await fetch(`/api/prices?tickers=${allTickers}`).catch(() => null);
    if (res && res.ok) {
      const data = await res.json();
      if (requestId !== priceRequestId) return;
      mergeObservedPrices(data);
    } else {
      // GitHub Pages 등 정적 호스팅(No-Backend) 환경 Fallback: 1분 주기로 최신 realtime_prices.json 및 latest_macro_indicators.json 폴링
      const priceRes = await fetch("realtime_prices.json?_t=" + Date.now()).catch(() => null);

      if (priceRes && priceRes.ok) {
        const pData = await priceRes.json().catch(() => null);
        if (pData && requestId === priceRequestId) {
          mergeObservedPrices(pData);
        }
      }

    }
    await refreshMacroSnapshot(requestId);
  } catch (e) {
    console.warn('Quote refresh unavailable; retained observations will age normally.', e);
  } finally {
    if (requestId === priceRequestId && guruKey === state.currentGuruKey) refreshVisibleQuotes();
  }
}

function refreshVisibleQuotes() {
  Object.values(GURU_DATABASE).forEach(g => applyLivePricesToHoldings(g.holdings));
  const guru = GURU_DATABASE[state.currentGuruKey];
  if (state.currentFilingType === '13F' && guru) {
    updateSummaryMetrics(guru);
    renderTable(true);
    if (typeof renderTreemap === 'function') renderTreemap(guru.holdings);
  }
  if (typeof renderConsensusWidget === 'function') renderConsensusWidget();
  if (typeof ACTIVE_STOCK_ITEM !== 'undefined' && ACTIVE_STOCK_ITEM) {
    const modal = document.getElementById('stockModal');
    if (modal && modal.classList.contains('show')) {
      const identity = holdingIdentity(ACTIVE_STOCK_ITEM);
      const sourceGuru = typeof ACTIVE_STOCK_GURU_KEY !== 'undefined' && ACTIVE_STOCK_GURU_KEY ? GURU_DATABASE[ACTIVE_STOCK_GURU_KEY] : guru;
      const refreshedItem = (sourceGuru && sourceGuru.holdings || []).find(h => holdingIdentity(h) === identity);
      if (refreshedItem && refreshedItem !== ACTIVE_STOCK_ITEM && ACTIVE_STOCK_ITEM.cusip) {
        // Metadata recovery can replace an unresolved holding with its verified
        // identity. Rebuild the open modal, including links and the holders list.
        ACTIVE_STOCK_ITEM = refreshedItem;
        openStockModal(refreshedItem);
      } else {
        applyLivePricesToHoldings([ACTIVE_STOCK_ITEM]);
        renderStockQuote(ACTIVE_STOCK_ITEM);
      }
    }
  }
}

function applyLivePricesToHoldings(holdings) {
  if (!holdings || !holdings.length) return;
  holdings.forEach(h => {
    const key = canonicalTicker(h.baseTicker || h.ticker);
    const info = LIVE_PRICES[key];
    Object.assign(h, quoteFields(key, info));
  });
}

async function loadRealSecData() {
  try {
    const [displayResult, tickerRes, priceRes, macroRes, symbolsRes] = await Promise.all([
      Promise.resolve().then(() => SECDisplayLoader.load({ baseURL: new URL("./", document.baseURI) })).then(value => ({ value }), error => ({ error })),
      fetch("ticker_map.json?_t=" + Date.now()).catch(() => null),
      fetch("realtime_prices.json?_t=" + Date.now()).catch(() => null),
      fetch("latest_macro_indicators.json?_t=" + Date.now()).catch(() => null),
      fetch("market_symbols.json?_t=" + Date.now()).catch(() => null)
    ]);

    if (symbolsRes && symbolsRes.ok) {
      try {
        const symbols = await symbolsRes.json();
        if (symbols && symbols.aliases && symbols.inactive && symbols.nonEquityCusips && symbols.reviewedCusips && symbols.quarantinedCusips) MARKET_SYMBOLS = symbols;
      } catch (e) {}
    }
    if (tickerRes && tickerRes.ok) {
      try {
        const extMap = await tickerRes.json();
        Object.assign(TICKER_MAP, extMap);
      } catch (e) {}
    }
    if (priceRes && priceRes.ok) {
      try {
        mergeObservedPrices(await priceRes.json());
      } catch (e) {}
    }
    if (macroRes && macroRes.ok) {
      try {
        MACRO_DATA = normalizeMacroData(await macroRes.json());
        renderMacroPulseBar();
      } catch (e) {}
    }
    SEC_DISPLAY = displayResult.value || null;
    RAW_HOLDINGS = SEC_DISPLAY ? SEC_DISPLAY.rows : [];
    SEC_DISPLAY_ROWS = new WeakSet(RAW_HOLDINGS);
    renderPartialCoverage(displayResult.error);
    if (!SEC_DISPLAY) showUnavailableHoldings();

    // 최신 데이터로 화면 연산 및 렌더링
    processAndRenderHoldingsData();

    // 초기 로드 직후 현재 화면 실시간가 즉시 온디맨드 fetch
    fetchLivePricesForCurrentView();

    // 백그라운드 프리페치 (Form 4 및 13D 데이터)
    if (window.requestIdleCallback) {
      requestIdleCallback(() => prefetchOtherFilings());
    } else {
      setTimeout(prefetchOtherFilings, 1000);
    }
  } catch (e) {
    SEC_DISPLAY = null;
    showUnavailableHoldings();
    renderPartialCoverage(e);
    console.error("데이터 로드 실패:", e);
  }
}

function formatQuarterDisplay(periodStr) {
  if (!periodStr) return "최신 13F 공시";
  
  // YYYY-MM-DD 형식 파싱
  const m = String(periodStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const year = m[1];
    const month = parseInt(m[2], 10);
    const day = m[3];
    let q = 1;
    if (month <= 3) q = 1;
    else if (month <= 6) q = 2;
    else if (month <= 9) q = 3;
    else q = 4;
    return `${year} Q${q} (${year}.${m[2]}.${day} 기준)`;
  }
  
  const qm = String(periodStr).match(/^(\d{4})Q([1-4])/i);
  if (qm) {
    return `${qm[1]} Q${qm[2]} 기준`;
  }
  
  return `${periodStr} 기준`;
}

let DOMINANT_13F_PERIOD = null;

function processAndRenderHoldingsData(preserveView = false) {
  if (!SEC_DISPLAY || !RAW_HOLDINGS || RAW_HOLDINGS.length === 0) { showUnavailableHoldings(); return; }
  
  try {
    const groups = Object.create(null);
    const grandConsensusMap = Object.create(null);
    let grandTotalAumVal = 0;

    // 데이터셋 전체에서 가장 대표적인(최빈) 분기 말일 추출
    const periodCounts = {};
    RAW_HOLDINGS.forEach(item => {
      if (item.period) {
        periodCounts[item.period] = (periodCounts[item.period] || 0) + 1;
      }
    });
    let dominantPeriod = null;
    let maxCount = 0;
    for (const [p, cnt] of Object.entries(periodCounts)) {
      if (cnt > maxCount) {
        maxCount = cnt;
        dominantPeriod = p;
      }
    }
    DOMINANT_13F_PERIOD = dominantPeriod;
    const knownPeriods = Object.keys(periodCounts).filter(p => /^\d{4}-\d{2}-\d{2}$/.test(p)).sort();
    const latestDatasetPeriod = knownPeriods.at(-1) || null;
    
    RAW_HOLDINGS.forEach((item, rowIndex) => {
      if (!verifiedDisplayRow(item) || (item.schemaVersion !== 3 && isDerivativeOrOption(item.name, item.ticker, item.titleOfClass, item))) return;

      const guruName = item.legalName;
      const fundName = item.legalName;
      if (!groups[guruName]) {
        const initials = fundName.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
        const guruPeriod = item.period || null;
        groups[guruName] = {
          name: guruName,
          fund: fundName,
          avatar: initials || "CO",
          quarter: formatQuarterDisplay(guruPeriod),
          periodDate: guruPeriod,
          filingDate: item.filingDate || null,
          cik: item.cik,
          sources: (SEC_DISPLAY.sources || []).filter(source => source.cik === item.cik),
          latestDatasetPeriod,
          desc: `${fundName} SEC 신고 법인의 확인된 공시 부분집합. 원래 추적명은 운용 관계의 증명이 아닙니다.`,
          holdingsMap: Object.create(null)
        };
      }
      
      if (!groups[guruName].sources.some(source => source.accession === item.accession)) groups[guruName].sources.push({ accession: item.accession, sourceUrl: item.sourceUrl, period: item.period, filingDate: item.filingDate });
      const baseTicker = getMappedTicker(item.name, item.ticker, item.cusip, item.shareType, item.putCall || item.optionType);
      const cusip = String(item.cusip || '').toUpperCase().trim();
      const securityId = holdingIdentity({ ...item, securityId: null }, rowIndex);
      const shareType = item.shareType || 'SH';
      const putCall = item.putCall || item.optionType || null;
      const hMap = groups[guruName].holdingsMap;
      const accurateSector = getMappedSector(baseTicker, item.sector);

      let displayName = item.name || baseTicker;
      if (baseTicker === "SPY") displayName = "SPDR S&P 500 ETF Trust";
      else if (baseTicker === "IVV") displayName = "iShares Core S&P 500 ETF";
      else if (baseTicker === "QQQ") displayName = "Invesco QQQ Trust";
      else if (baseTicker === "IWM") displayName = "iShares Russell 2000 ETF";
      else if (baseTicker === "GLD") displayName = "SPDR Gold Trust";
      else if (baseTicker === "EEM") displayName = "iShares MSCI Emerging Markets ETF";

      const itemShares = Number(item.shares) || 0;
      const itemVal = Number(item.value) || 0;

      if (!hMap[securityId]) {
        hMap[securityId] = {
          ticker: baseTicker,
          baseTicker: baseTicker,
          name: displayName,
          sector: accurateSector,
          shares: itemShares,
          value: itemVal,
          cusip: cusip,
          securityId, shareType, putCall,
          securityClass: item.securityClass || item.titleOfClass || '',
          periods: new Set(item.period ? [item.period] : []),
          action: "UNKNOWN",
          isOption: item.isOption || false
        };
      } else {
        hMap[securityId].shares += itemShares;
        hMap[securityId].value += itemVal;
        if (item.period) hMap[securityId].periods.add(item.period);
        if (item.action && item.action !== "None" && item.action !== "HOLD") {
          hMap[securityId].action = "UNKNOWN";
        }
      }

      if (!grandConsensusMap[securityId]) {
        grandConsensusMap[securityId] = {
          ticker: baseTicker,
          baseTicker: baseTicker,
          name: displayName,
          sector: accurateSector,
          cusip: cusip,
          securityId, shareType, putCall,
          securityClass: item.securityClass || item.titleOfClass || '',
          periods: new Set(item.period ? [item.period] : []),
          shares: itemShares,
          value: itemVal,
          holders: new Set([guruName])
        };
      } else {
        grandConsensusMap[securityId].shares += itemShares;
        grandConsensusMap[securityId].value += itemVal;
        if (item.period) grandConsensusMap[securityId].periods.add(item.period);
        grandConsensusMap[securityId].holders.add(guruName);
      }
      
      grandTotalAumVal += itemVal;
    });

    Object.keys(groups).forEach(key => {
      const g = groups[key];
      const holdingList = Object.values(g.holdingsMap);
      const totalVal = holdingList.reduce((sum, h) => sum + h.value, 0);
      g.rawAum = totalVal;
      g.aum = formatMoney(totalVal);
      
      g.holdings = holdingList.map(h => {
        const weight = totalVal > 0 ? Number(((h.value / totalVal) * 100).toFixed(2)) : 0;
        const estP = null;
        const periods = Array.from(h.periods).sort();
        
        const realInfo = LIVE_PRICES[h.baseTicker] || LIVE_PRICES[h.ticker];
        const currentQuote = quoteFields(h.baseTicker || h.ticker, realInfo);
        const curP = currentQuote.curPrice;
        
        let action = "UNKNOWN";
        if (h.isOption || action === "PUT") {
          action = "PUT";
        }

        return {
          ticker: h.ticker,
          baseTicker: h.baseTicker,
          name: h.name,
          sector: h.sector,
          cusip: h.cusip,
          securityId: h.securityId,
          shareType: h.shareType,
          putCall: h.putCall,
          securityClass: h.securityClass,
          periodDate: periods.length === 1 ? periods[0] : null,
          periodRange: periods.length ? [periods[0], periods.at(-1)] : null,
          holdersDisplay: "1개사 (단독)",
          action: action,
          shares: h.shares >= 1000000 ? `${(h.shares / 1000000).toFixed(2)}M` : `${(h.shares / 1000).toFixed(1)}K`,
          rawShares: h.shares,
          value: h.value,
          weight: weight,
          estPrice: estP,
          ...currentQuote,
          insight: `${h.name} 보통주 - ${g.name} 포트폴리오의 ${weight}% 차지 (최근 조회 시세: ${priceLabel(curP)})`
        };
      });

      g.holdings.sort((a, b) => b.weight - a.weight);
    });

    const grandList = Object.values(grandConsensusMap);
    const grandHoldings = grandList.map(h => {
      const weight = grandTotalAumVal > 0 ? Number(((h.value / grandTotalAumVal) * 100).toFixed(2)) : 0;
      const estP = null;
      const periods = Array.from(h.periods).sort();
      
      const realInfo = LIVE_PRICES[h.baseTicker] || LIVE_PRICES[h.ticker];
      const currentQuote = quoteFields(h.baseTicker || h.ticker, realInfo);
      
      const holderCount = h.holders.size;
      let action = "UNKNOWN";

      return {
        ticker: h.ticker,
        baseTicker: h.baseTicker,
        name: h.name,
        sector: h.sector,
        cusip: h.cusip,
        securityId: h.securityId,
        shareType: h.shareType,
        putCall: h.putCall,
        securityClass: h.securityClass,
        periodDate: periods.length === 1 ? periods[0] : null,
        periodRange: periods.length ? [periods[0], periods.at(-1)] : null,
        holders: holderCount,
        holdersList: Array.from(h.holders),
        holdersDisplay: `${holderCount}개사 보유`,
        action: action,
        shares: h.shares >= 1000000 ? `${(h.shares / 1000000).toFixed(2)}M` : `${(h.shares / 1000).toFixed(1)}K`,
        rawShares: h.shares,
        value: h.value,
        weight: weight,
        estPrice: estP,
        ...currentQuote,
        insight: `확인된 공시 부분집합 내 ${holderCount}개 SEC 신고 법인의 공통 보고 종목`
      };
    });

    grandHoldings.sort((a, b) => b.value - a.value);

    GURU_DATABASE = {
      "__GRAND_TOTAL__": {
        name: "확인된 공시 부분집합",
        fund: "43/50 추적명 · 42개 SEC 신고 법인 · 7개 검증 중",
        avatar: "ALL",
        aum: grandHoldings.length ? formatMoney(grandTotalAumVal) : "확인된 수치 없음",
        rawAum: grandHoldings.length ? grandTotalAumVal : null,
        quarter: `${formatQuarterDisplay(dominantPeriod)} 종합`,
        periodDate: dominantPeriod,
        periodRange: knownPeriods.length ? [knownPeriods[0], latestDatasetPeriod] : null,
        desc: "서로 다른 기준일의 확인된 SEC 공시 부분집합만 합산합니다. 전체 커버리지나 현재 실시간 포트폴리오가 아닙니다.",
        holdings: grandHoldings
      },
      ...groups
    };

    renderCategoryTabs();
    renderGuruSidebar();
    if (preserveView && state.currentGuruKey === '__CUSTOM_GROUP__') {
      buildCustomGroupPortfolio(true);
    } else if (preserveView) {
      if (!GURU_DATABASE[state.currentGuruKey]) state.currentGuruKey = '__GRAND_TOTAL__';
      if (state.currentFilingType === '13F') loadGuruData(state.currentGuruKey);
    } else {
      selectGuru("__GRAND_TOTAL__");
    }
    renderConsensusWidget("HOLDERS");

  } catch (err) {
    console.error("데이터 로드 실패:", err);
  }
}

function buildCustomGroupPortfolio(preserveView = false) {
  const favs = getFavorites();
  if (favs.length === 0) {
    alert("먼저 사이드바에서 관심 있는 운용사 옆의 별표를 1개 이상 눌러 즐겨찾기에 등록해 주세요.");
    return;
  }

  const customConsensusMap = Object.create(null);
  let customTotalAumVal = 0;

  favs.forEach(guruKey => {
    const guru = GURU_DATABASE[guruKey];
    if (!guru || !guru.holdings) return;

    guru.holdings.forEach((h, rowIndex) => {
      const ticker = h.baseTicker || h.ticker;
      const securityId = holdingIdentity(h, `${guruKey}:${rowIndex}`);
      const periods = h.periodRange || (h.periodDate ? [h.periodDate] : []);
      if (!customConsensusMap[securityId]) {
        customConsensusMap[securityId] = {
          ticker: ticker,
          baseTicker: h.baseTicker || ticker,
          name: h.name,
          sector: h.sector,
          cusip: h.cusip,
          securityId,
          shareType: h.shareType || 'SH',
          putCall: h.putCall || null,
          securityClass: h.securityClass || '',
          periods: new Set(periods),
          shares: Number(h.rawShares) || 0,
          value: Number(h.value) || 0,
          estPrice: h.estPrice,
          curPrice: h.curPrice,
          priceChangePct: h.priceChangePct,
          quoteAsOf: h.quoteAsOf,
          holders: new Set([guru.name])
        };
      } else {
        customConsensusMap[securityId].shares += (Number(h.rawShares) || 0);
        customConsensusMap[securityId].value += (Number(h.value) || 0);
        periods.forEach(period => customConsensusMap[securityId].periods.add(period));
        customConsensusMap[securityId].holders.add(guru.name);
      }
      customTotalAumVal += Number(h.value) || 0;
    });
  });

  const customList = Object.values(customConsensusMap);
  const customHoldings = customList.map(h => {
    const weight = customTotalAumVal > 0 ? Number(((h.value / customTotalAumVal) * 100).toFixed(2)) : 0;
    const holderCount = h.holders.size;
    const periods = Array.from(h.periods).sort();
    let action = "UNKNOWN";
    // Shared ownership alone is not evidence of a quarter-over-quarter purchase.

    return {
      ticker: h.ticker,
      baseTicker: h.baseTicker,
      name: h.name,
      sector: h.sector,
      cusip: h.cusip,
      securityId: h.securityId,
      shareType: h.shareType,
      putCall: h.putCall,
      securityClass: h.securityClass,
      periodDate: periods.length === 1 ? periods[0] : null,
      periodRange: periods.length ? [periods[0], periods.at(-1)] : null,
      holders: holderCount,
      holdersList: Array.from(h.holders),
      holdersDisplay: `${holderCount}개사 보유`,
      action: action,
      shares: h.shares >= 1000000 ? `${(h.shares / 1000000).toFixed(2)}M` : `${(h.shares / 1000).toFixed(1)}K`,
      rawShares: h.shares,
      value: h.value,
      weight: weight,
      estPrice: null,
      ...quoteFields(h.baseTicker || h.ticker, LIVE_PRICES[canonicalTicker(h.baseTicker || h.ticker)]),
      insight: `내가 선택한 ${favs.length}개 즐겨찾기 운용사 중 ${holderCount}개사가 공통 보유한 핵심 자산`
    };
  });

  customHoldings.sort((a, b) => b.value - a.value);

  const selectedPeriods = favs.map(key => GURU_DATABASE[key]?.periodDate).filter(Boolean).sort();
  GURU_DATABASE["__CUSTOM_GROUP__"] = {
    name: "즐겨찾기 묶어보기",
    fund: `선택한 ${favs.length}개 운용사 맞춤 합산`,
    avatar: "FAV",
    aum: customHoldings.length ? formatMoney(customTotalAumVal) : "확인된 수치 없음",
    rawAum: customHoldings.length ? customTotalAumVal : null,
    quarter: `${formatQuarterDisplay(DOMINANT_13F_PERIOD)} 맞춤 종합`,
    periodDate: DOMINANT_13F_PERIOD,
    periodRange: selectedPeriods.length ? [selectedPeriods[0], selectedPeriods.at(-1)] : null,
    desc: `선택한 SEC 신고 법인들의 확인된 공시 부분집합 합산입니다. 현재 실시간 포트폴리오가 아닙니다.`,
    sources: (SEC_DISPLAY?.sources || []).filter(source => favs.some(key => GURU_DATABASE[key]?.cik === source.cik)),
    holdings: customHoldings
  };

  if (preserveView) {
    if (state.currentFilingType === '13F') loadGuruData('__CUSTOM_GROUP__');
  } else {
    selectGuru("__CUSTOM_GROUP__");
  }
}

function renderCategoryTabs() {
  const container = document.querySelector(".guru-selector-box");
  if (!container) return;

  let existing = document.getElementById("guruCategoryTabs");
  if (!existing) {
    existing = document.createElement("div");
    existing.id = "guruCategoryTabs";
    existing.className = "guru-cat-filters";
    const lbl = container.querySelector(".section-label");
    if (lbl) lbl.after(existing);
  }

  const favs = getFavorites();
  const favCount = favs.length;

  const subtextEl = document.getElementById("customGroupSubtext");
  if (subtextEl) {
    subtextEl.innerText = `내가 찜한 ${favCount}개 운용사 합산`;
  }

  if (CURRENT_USER) {
    existing.innerHTML = `
      <div class="cat-pill-row">
        <button class="cat-pill ${state.activeCategory === 'ALL' ? 'active' : ''}" data-cat="ALL">전체</button>
        <button class="cat-pill ${state.activeCategory === 'FAV' ? 'active' : ''}" data-cat="FAV">즐겨찾기 (${favCount})</button>
        <button class="cat-pill ${state.activeCategory === 'TOP20' ? 'active' : ''}" data-cat="TOP20">Top 20</button>
      </div>
    `;
  } else {
    existing.innerHTML = `
      <div class="cat-pill-row">
        <button class="cat-pill ${state.activeCategory === 'ALL' ? 'active' : ''}" data-cat="ALL">전체</button>
        <button class="cat-pill ${state.activeCategory === 'TOP20' ? 'active' : ''}" data-cat="TOP20">Top 20</button>
      </div>
    `;
  }

  existing.querySelectorAll(".cat-pill").forEach(btn => {
    btn.onclick = () => {
      existing.querySelectorAll(".cat-pill").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.activeCategory = btn.dataset.cat;
      renderGuruSidebar();
    };
  });
}

function renderGuruSidebar() {
  const listEl = document.getElementById("guruList");
  if (!listEl) return;
  listEl.innerHTML = "";

  const favs = getFavorites();
  const subtextEl = document.getElementById("customGroupSubtext");
  if (subtextEl) {
    subtextEl.innerText = `내가 찜한 ${favs.length}개 운용사 합산`;
  }

  const btnGrand = document.getElementById("btnGrandTotal");
  if (btnGrand) {
    btnGrand.classList.toggle("active", state.currentGuruKey === "__GRAND_TOTAL__");
  }

  const btnCustom = document.getElementById("btnCustomGroup");
  if (btnCustom) {
    btnCustom.classList.toggle("active", state.currentGuruKey === "__CUSTOM_GROUP__");
  }

  let keys = Object.keys(GURU_DATABASE).filter(k => k !== "__GRAND_TOTAL__" && k !== "__CUSTOM_GROUP__");

  // 1차 기준: 총 운용자산 규모(AUM) 내림차순 정렬
  keys.sort((a, b) => (GURU_DATABASE[b].rawAum || 0) - (GURU_DATABASE[a].rawAum || 0));

  if (CURRENT_USER && state.activeCategory === "FAV") {
    keys = keys.filter(k => favs.includes(k));
  } else if (state.activeCategory === "TOP20") {
    keys = keys.slice(0, 20);
  } else if (CURRENT_USER) {
    // [전체] 탭일 때는 즐겨찾기(★) 운용사 최상단 배치
    const favKeys = keys.filter(k => favs.includes(k));
    const nonFavKeys = keys.filter(k => !favs.includes(k));
    keys = [...favKeys, ...nonFavKeys];
  }

  keys.forEach(key => {
    const guru = GURU_DATABASE[key];
    const isFav = favs.includes(key);

    const row = document.createElement("div");
    row.className = "guru-row-item";

    if (CURRENT_USER) {
      const starBtn = document.createElement("button");
      starBtn.className = `star-btn ${isFav ? 'starred' : ''}`;
      starBtn.innerHTML = isFav ? "★" : "☆";
      starBtn.title = isFav ? "즐겨찾기 해제" : "즐겨찾기 추가";
      starBtn.onclick = (e) => {
        e.stopPropagation();
        toggleFavorite(key);
      };
      row.appendChild(starBtn);
    }

    const btn = document.createElement("button");
    btn.className = `guru-card-btn ${key === state.currentGuruKey ? 'active' : ''}`;
    btn.onclick = () => selectGuru(key);

    btn.innerHTML = `
      <div class="guru-mini-avatar">${escapeHtml(guru.avatar || 'CO')}</div>
      <div class="guru-card-info">
        <h4>${escapeHtml(guru.fund || guru.name)}</h4>
        <p>${escapeHtml(guru.name)} · <small class="text-green">${escapeHtml(guru.aum || '')}</small></p>
      </div>
    `;

    row.appendChild(btn);
    listEl.appendChild(row);
  });
}

function selectGuru(key) {
  state.currentGuruKey = key;
  state.activeFilter = "ALL";
  state.searchQuery = "";
  const sInput = document.getElementById("searchInput");
  if (sInput) sInput.value = "";
  
  document.querySelectorAll(".filter-tab").forEach(tab => {
    tab.classList.toggle("active", tab.dataset.filter === "ALL");
  });

  renderGuruSidebar();
  loadGuruData(key);

  // 운용사 전환 시 즉시 실시간가 온디맨드 fetch
  fetchLivePricesForCurrentView();
}

function loadGuruData(key) {
  const guru = GURU_DATABASE[key];
  if (!guru) return;
  applyLivePricesToHoldings(guru.holdings);

  const isSpecial = key === "__GRAND_TOTAL__" || key === "__CUSTOM_GROUP__";
  const elName = document.getElementById("currentGuruName");
  if (elName) elName.innerText = isSpecial ? guru.name : (guru.fund || guru.name);
  const elFund = document.getElementById("currentFundName");
  if (elFund) elFund.innerText = isSpecial ? guru.fund : guru.name;
  const elQuarter = document.getElementById("currentQuarter");
  if (elQuarter) {
    elQuarter.innerText = guru.quarter;
    elQuarter.title = "SEC 13F 공시 규정에 따라 각 분기 마지막 거래일 시장 마감 기준 보유 현황입니다.";
  }
  const elDesc = document.getElementById("currentGuruDesc");
  if (elDesc) elDesc.innerText = `${guru.desc} · ${portfolioFreshness(guru)}`;

  renderSelectedSources(guru);
  updateSummaryMetrics(guru);
  renderSectorBreakdown(guru.holdings);
  renderTreemap(guru.holdings);
  renderTable();
}

function updateSummaryMetrics(guru) {
  if (!guru) return;

  const elAum = document.getElementById("metricTotalAum");
  if (elAum) elAum.innerText = guru.aum || "-";

  const isGrandTotal = state.currentGuruKey === "__GRAND_TOTAL__" || state.currentGuruKey === "__CUSTOM_GROUP__";
  const elHoldings = document.getElementById("metricTotalHoldings");
  const elTopBuy = document.getElementById("metricTopBuy");
  const elTopBuySub = document.getElementById("metricTopBuySub");
  const elDisc = document.getElementById("metricDiscountPick");
  const elDiscSub = document.getElementById("metricDiscountSub");
  const elTopHold = document.getElementById("metricTopHolding");
  const elTopHoldSub = document.getElementById("metricTopHoldingSub");
  
  [elTopBuy, elDisc, elTopHold].forEach(el => { if (el) el.innerText = '-'; });
  [elTopBuySub, elDiscSub, elTopHoldSub].forEach(el => { if (el) el.innerText = '확인 가능한 데이터 없음'; });
  if (isGrandTotal) {
    if (elHoldings) elHoldings.innerText = `총 분석 종목 ${guru.holdings.length}개`;
    
    const sortedByHolders = [...guru.holdings].sort((a, b) => (b.holders || 1) - (a.holders || 1));
    const topHolderPick = sortedByHolders[0];
    if (topHolderPick && elTopBuy) {
      elTopBuy.innerHTML = `${escapeHtml(topHolderPick.ticker)} <small class="text-green">${topHolderPick.holders}개사 보유</small>`;
      if (elTopBuySub) elTopBuySub.innerText = `${topHolderPick.name} (${formatMoney(topHolderPick.value)})`;
    }

    const discounts = guru.holdings
      .filter(h => h.action !== 'PUT' && h.action !== 'CALL' && !h.isOption && Number.isFinite(priceDifference(h)))
      .map(h => ({ ...h, discountPct: priceDifference(h) }))
      .sort((a, b) => a.discountPct - b.discountPct);
    const bestDiscount = discounts[0];
    if (bestDiscount && bestDiscount.discountPct < 0 && elDisc) {
      elDisc.innerHTML = `${escapeHtml(bestDiscount.ticker)} <small class="text-red">${bestDiscount.discountPct.toFixed(1)}%</small>`;
      if (elDiscSub) elDiscSub.innerText = `공시 평가단가 대비 하락`;
    }

    const top1 = guru.holdings[0];
    if (top1 && elTopHold) {
      elTopHold.innerHTML = `${escapeHtml(top1.ticker)} <small>${top1.weight}%</small>`;
      if (elTopHoldSub) elTopHoldSub.innerText = `${top1.name} (${formatMoney(top1.value)})`;
    }
  } else {
    if (elHoldings) elHoldings.innerText = `보유 종목 ${guru.holdings.length}개`;

    const buyPicks = guru.holdings.filter(h => h.action === "NEW" || h.action === "ADD");
    if (buyPicks.length > 0 && elTopBuy) {
      const topBuy = buyPicks[0];
      elTopBuy.innerHTML = `${escapeHtml(topBuy.ticker)} <small class="text-green">${topBuy.action === 'NEW' ? 'NEW' : 'ADD'}</small>`;
      if (elTopBuySub) elTopBuySub.innerText = `${topBuy.name} (${formatMoney(topBuy.value)})`;
    }

    const discounts = guru.holdings
      .filter(h => h.action !== 'PUT' && h.action !== 'CALL' && !h.isOption && Number.isFinite(priceDifference(h)))
      .map(h => ({ ...h, discountPct: priceDifference(h) }))
      .sort((a, b) => a.discountPct - b.discountPct);
    const bestDiscount = discounts[0];
    if (bestDiscount && bestDiscount.discountPct < 0 && elDisc) {
      elDisc.innerHTML = `${escapeHtml(bestDiscount.ticker)} <small class="text-purple">${bestDiscount.discountPct.toFixed(1)}%</small>`;
      if (elDiscSub) elDiscSub.innerText = `공시 평가단가 대비 하락`;
    }

    const top1 = guru.holdings[0];
    if (top1 && elTopHold) {
      elTopHold.innerHTML = `${escapeHtml(top1.ticker)} <small>${top1.weight}%</small>`;
      if (elTopHoldSub) elTopHoldSub.innerText = `${top1.name} (${formatMoney(top1.value)})`;
    }
  }
}

// 기능 3: 섹터(산업군) 자금 쏠림 비중 분석 위젯 렌더링
function renderSectorBreakdown(holdings) {
  const barContainer = document.getElementById("sectorStackedBar");
  const legendContainer = document.getElementById("sectorLegend");
  if (!barContainer || !legendContainer || !holdings) return;

  barContainer.innerHTML = "";
  legendContainer.innerHTML = "";

  const sectorTotals = {};
  let totalVal = 0;

  holdings.forEach(h => {
    const sec = h.sector || "Other";
    const v = Number(h.value) || 0;
    sectorTotals[sec] = (sectorTotals[sec] || 0) + v;
    totalVal += v;
  });

  if (totalVal <= 0) return;

  const sortedSectors = Object.entries(sectorTotals)
    .map(([sec, val]) => ({ sector: sec, val: val, pct: (val / totalVal) * 100 }))
    .sort((a, b) => b.val - a.val);

  sortedSectors.forEach(item => {
    if (item.pct < 0.5) return;
    const color = SECTOR_COLORS[item.sector] || SECTOR_COLORS.Other;

    // 스택 바 세그먼트
    const seg = document.createElement("div");
    seg.className = "sector-segment";
    seg.style.width = `${item.pct}%`;
    seg.style.backgroundColor = color;
    seg.title = `${item.sector}: ${item.pct.toFixed(1)}% (${formatMoney(item.val)})`;
    barContainer.appendChild(seg);

    // 레전드 태그
    const tag = document.createElement("div");
    tag.className = "sector-legend-tag";
    tag.innerHTML = `
      <span class="sector-dot" style="background-color: ${color};"></span>
      <span>${escapeHtml(item.sector)} <strong>${item.pct.toFixed(1)}%</strong></span>
    `;
    legendContainer.appendChild(tag);
  });
}

// 2D Squarified Treemap 분할 알고리즘 (Finviz / Bloomberg 스타일)
function computeSquarifiedTreemap(items, x, y, width, height) {
  if (!items || items.length === 0) return [];
  if (items.length === 1) {
    return [{ item: items[0].raw, x, y, width, height }];
  }

  const totalValue = items.reduce((sum, d) => sum + d.val, 0);
  if (totalValue <= 0) return [];

  const results = [];
  const isHorizontal = width >= height;

  let bestRatio = Infinity;
  let splitIndex = 1;
  let currentSum = 0;

  for (let i = 0; i < items.length; i++) {
    currentSum += items[i].val;
    const sliceFraction = currentSum / totalValue;
    const sliceLength = isHorizontal ? width * sliceFraction : height * sliceFraction;
    const otherLength = isHorizontal ? height : width;

    let maxRatio = 0;
    for (let j = 0; j <= i; j++) {
      const itemDim = otherLength * (items[j].val / currentSum);
      const ratio = Math.max(sliceLength / Math.max(itemDim, 1), itemDim / Math.max(sliceLength, 1));
      if (ratio > maxRatio) maxRatio = ratio;
    }

    if (maxRatio <= bestRatio) {
      bestRatio = maxRatio;
      splitIndex = i + 1;
    } else {
      break;
    }
  }

  const sliceGroup = items.slice(0, splitIndex);
  const restGroup = items.slice(splitIndex);
  const sliceSum = sliceGroup.reduce((s, d) => s + d.val, 0);
  const sliceFraction = sliceSum / totalValue;

  if (isHorizontal) {
    const sliceWidth = width * sliceFraction;
    let currY = y;
    sliceGroup.forEach(d => {
      const h = height * (d.val / sliceSum);
      results.push({ item: d.raw, x, y: currY, width: sliceWidth, height: h });
      currY += h;
    });
    if (restGroup.length > 0) {
      const restResults = computeSquarifiedTreemap(restGroup, x + sliceWidth, y, width - sliceWidth, height);
      return results.concat(restResults);
    }
    return results;
  } else {
    const sliceHeight = height * sliceFraction;
    let currX = x;
    sliceGroup.forEach(d => {
      const w = width * (d.val / sliceSum);
      results.push({ item: d.raw, x: currX, y, width: w, height: sliceHeight });
      currX += w;
    });
    if (restGroup.length > 0) {
      const restResults = computeSquarifiedTreemap(restGroup, x, y + sliceHeight, width, height - sliceHeight);
      return results.concat(restResults);
    }
    return results;
  }
}

// 대표 브랜드명 정제 매핑 (트리맵 등에서 불필요하게 잘리지 않고 깔끔하게 표기)
const CLEAN_COMPANY_NAMES = {
  "NVDA": "Nvidia",
  "AAPL": "Apple",
  "GOOGL": "Alphabet (Google)",
  "GOOG": "Alphabet (Google)",
  "MSFT": "Microsoft",
  "AMZN": "Amazon",
  "META": "Meta Platforms",
  "TSLA": "Tesla",
  "AMD": "AMD",
  "MU": "Micron",
  "AXP": "American Express",
  "BAC": "Bank of America",
  "KO": "Coca-Cola",
  "SPY": "SPDR S&P 500 ETF",
  "QQQ": "Invesco QQQ ETF",
  "IVV": "iShares S&P 500",
  "AVGO": "Broadcom",
  "TSM": "TSMC",
  "NFLX": "Netflix",
  "BABA": "Alibaba",
  "INTC": "Intel",
  "CVX": "Chevron",
  "OXY": "Occidental",
  "CB": "Chubb",
  "IWM": "iShares Russell 2000",
  "SANDI": "SanDisk",
  "SPACE": "Space Exploration",
  "VANEC": "VanEck Bitcoin ETF",
  "MCO": "Moody's",
  "V": "Visa",
  "MELI": "MercadoLibre",
  "LRCX": "Lam Research",
  "GE": "GE Aerospace"
};

function getCleanCompanyName(ticker, rawName) {
  if (CLEAN_COMPANY_NAMES[ticker]) return CLEAN_COMPANY_NAMES[ticker];
  if (!rawName) return ticker;
  // 법인 접미사 깔끔하게 정돈
  return rawName
    .replace(/\s+(CORP|CORPORATION|INC|CO|LTD|LLC|PLC|LP|HOLDINGS|HOLDING)\b.*$/i, '')
    .trim();
}

function renderTreemap(holdings) {
  const container = document.getElementById("treemapContainer");
  if (!container || !holdings) return;
  container.innerHTML = "";

  // 상위 28대 핵심 종목 선별
  const displayHoldings = holdings.slice(0, 28);
  if (displayHoldings.length === 0) return;

  const totalWeight = displayHoldings.reduce((sum, h) => sum + Math.max(Number(h.weight) || 0.1, 0.05), 0);
  const items = displayHoldings.map(h => ({
    val: Math.max(Number(h.weight) || 0.1, 0.05),
    raw: h
  }));

  const containerWidth = container.clientWidth || 1000;
  const containerHeight = 520;

  const tiles = computeSquarifiedTreemap(items, 0, 0, containerWidth, containerHeight);

  const tooltip = document.getElementById("treemapTooltip");

  tiles.forEach(t => {
    const item = t.item;
    const tile = document.createElement("div");
    tile.className = 'treemap-tile'; tile.classList.add(['UNKNOWN','HOLD','PUT','CALL','NEW','ADD','REDUCE'].includes(item.action) ? item.action : 'UNKNOWN');
    
    // 크기 구분 클래스 (폭 85px 미만 또는 높이 65px 미만 시 소형 모드)
    const area = t.width * t.height;
    if (area > 24000 || (item.weight && item.weight >= 8.0)) {
      tile.classList.add("tile-large");
    } else if (t.width < 90 || t.height < 65 || area < 6500) {
      tile.classList.add("tile-small");
    }

    // 위치 및 크기 배치 (px)
    tile.style.left = `${t.x}px`;
    tile.style.top = `${t.y}px`;
    tile.style.width = `${t.width}px`;
    tile.style.height = `${t.height}px`;

    const isOption = item.action === 'PUT' || item.action === 'CALL' || item.isOption;
    const diffVal = priceDifference(item);
    const diffPct = diffVal.toFixed(1);
    const isDown = diffVal < 0;

    const hasRoomForName = t.height >= 60 && t.width >= 85;
    const hasRoomForDiscount = t.width >= 90;
    const cleanName = getCleanCompanyName(item.ticker, item.name);

    tile.innerHTML = `
      <div class="tile-top">
        <span class="tile-ticker">${escapeHtml(item.ticker)}</span>
        <div class="tile-badges">
          ${(isDown && hasRoomForDiscount && !isOption) ? '<span class="tile-discount-badge" title="분기말 대비 하락">▼</span>' : ''}
          <span class="tile-action ${escapeHtml(item.action)}">${escapeHtml(item.action === 'NEW' ? 'NEW' : item.action)}</span>
        </div>
      </div>
      ${hasRoomForName ? `<div class="tile-name" title="${escapeHtml(item.name)}">${escapeHtml(cleanName)}</div>` : ''}
      <div class="tile-bottom">
        <span class="tile-weight">${item.weight}%</span>
        <span class="tile-price">${escapeHtml(priceLabel(item.curPrice))}</span>
      </div>
    `;

    // 인터랙티브 플로팅 툴팁(Toast) 이벤트
    if (tooltip) {
      tile.addEventListener("mouseenter", (e) => {
        let actionLabel = '거래 방향 미검증';
        if (item.action === 'PUT') actionLabel = '풋옵션 (하락 베팅)';
        else if (item.action === 'CALL') actionLabel = '콜옵션 (상승 베팅)';
        else if (item.action === 'NEW') actionLabel = '신규 매수';
        else if (item.action === 'ADD') actionLabel = '비중 확대';
        else if (item.action === 'REDUCE') actionLabel = '비중 축소';

        const diffRow = !Number.isFinite(diffVal) ? `<div class="tooltip-row">${escapeHtml(priceComparisonReason(item))}</div>` : isOption ? `
          <div class="tooltip-row">
            <span class="tooltip-label">기초자산 변동</span>
            <span class="tooltip-val" style="color:var(--text-subdued)">${isDown ? diffPct + '% 하락' : '+' + diffPct + '% 상승'} (옵션 비교 제외)</span>
          </div>
        ` : `
          <div class="tooltip-row">
            <span class="tooltip-label">분기말 대비</span>
            <span class="tooltip-val">${isDown ? `<span style="color:var(--negative-red)">${diffPct}% 하락</span>` : `<span style="color:var(--spotify-green)">+${diffPct}% 상승</span>`}</span>
          </div>
        `;

        tooltip.innerHTML = `
          <div class="tooltip-header">
            <span class="tooltip-ticker">${escapeHtml(item.ticker)}</span>
            <div class="tooltip-badges">
              ${(isDown && !isOption) ? '<span class="tile-discount-badge" title="분기말 대비 하락">▼</span>' : ''}
              <span class="tile-action ${escapeHtml(item.action)}">${escapeHtml(item.action)} (${actionLabel})</span>
            </div>
          </div>
          <div class="tooltip-name">${escapeHtml(item.name || cleanName)}</div>
          <div class="tooltip-grid">
            <div class="tooltip-row">
              <span class="tooltip-label">포트폴리오 비중</span>
              <span class="tooltip-val" style="color:var(--spotify-green)">${item.weight}%</span>
            </div>
            <div class="tooltip-row">
              <span class="tooltip-label">총 평가 금액</span>
              <span class="tooltip-val">${formatMoney(item.value)}</span>
            </div>
            <div class="tooltip-row">
              <span class="tooltip-label">${isOption ? '기초자산 현재가' : '최근 조회 시세'}</span>
              <span class="tooltip-val">${escapeHtml(priceLabel(item.curPrice))}</span>
            </div>
            ${diffRow}
          </div>
        `;
        tooltip.style.left = `${e.clientX}px`;
        tooltip.style.top = `${e.clientY}px`;
        tooltip.classList.add("show");
      });

      tile.addEventListener("mousemove", (e) => {
        tooltip.style.left = `${e.clientX}px`;
        tooltip.style.top = `${e.clientY}px`;
      });

      tile.addEventListener("mouseleave", () => {
        tooltip.classList.remove("show");
      });
    }

    tile.onclick = () => {
      if (tooltip) tooltip.classList.remove("show");
      openStockModal(item);
    };
    container.appendChild(tile);
  });
}

// 윈도우 리사이즈 시 트리맵 및 매크로 차트 자동 재계산
window.addEventListener("resize", () => {
  const guru = GURU_DATABASE[state.currentGuruKey];
  if (guru && guru.holdings) {
    renderTreemap(guru.holdings);
  }
  const vMacro = document.getElementById("viewMacro");
  if (vMacro && vMacro.style.display !== "none") {
    renderYieldTimeSeriesChart(macroChartState.yieldPeriod);
    renderSpreadTimeSeriesChart(macroChartState.spreadPeriod);
  }
});

let CURRENT_FILTERED_ITEMS = [];
let CURRENT_PAGE_INDEX = 1;
const PAGE_SIZE = 60;

function renderTable(preservePages = false) {
  const pageCount = preservePages ? Math.max(1, CURRENT_PAGE_INDEX - 1) : 1;
  const guru = GURU_DATABASE[state.currentGuruKey];
  if (!guru) return;

  const tbody = document.getElementById("tableBody");
  if (!tbody) return;
  tbody.innerHTML = "";
  CURRENT_PAGE_INDEX = 1;

  CURRENT_FILTERED_ITEMS = guru.holdings.filter(item => {
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      const match = item.ticker.toLowerCase().includes(q) ||
                    item.name.toLowerCase().includes(q) ||
                    item.sector.toLowerCase().includes(q);
      if (!match) return false;
    }

    if (state.activeFilter === "NEW") return item.action === "NEW";
    if (state.activeFilter === "ADD") return item.action === "ADD";
    if (state.activeFilter === "DISCOUNT") {
      const isOption = item.action === "PUT" || item.action === "CALL" || item.isOption;
      return !isOption && priceDifference(item) < 0;
    }
    if (state.activeFilter === "CONVICTION") return item.weight >= 5.0;
    if (state.activeFilter === "CONSENSUS") return (item.holders || 1) >= 2;
    return true;
  });

  const cAll = document.getElementById("countAll");
  if (cAll) cAll.innerText = guru.holdings.length;
  const cNew = document.getElementById("countNew");
  if (cNew) cNew.innerText = guru.holdings.filter(h => h.action === "NEW").length;
  const cAdd = document.getElementById("countAdd");
  if (cAdd) cAdd.innerText = guru.holdings.filter(h => h.action === "ADD").length;
  const cDisc = document.getElementById("countDiscount");
  if (cDisc) cDisc.innerText = guru.holdings.filter(h => !(h.action === "PUT" || h.action === "CALL" || h.isOption) && priceDifference(h) < 0).length;
  const cConv = document.getElementById("countConviction");
  if (cConv) cConv.innerText = guru.holdings.filter(h => h.weight >= 5.0).length;

  CURRENT_FILTERED_ITEMS.sort((a, b) => {
    let valA = a[state.sortColumn];
    let valB = b[state.sortColumn];

    if (state.sortColumn === "discount") {
      const isOptionA = a.action === "PUT" || a.action === "CALL" || a.isOption;
      const isOptionB = b.action === "PUT" || b.action === "CALL" || b.isOption;
      valA = isOptionA ? NaN : priceDifference(a);
      valB = isOptionB ? NaN : priceDifference(b);
    }

    if (valA == null || (typeof valA === "number" && !Number.isFinite(valA))) return valB == null || (typeof valB === "number" && !Number.isFinite(valB)) ? 0 : 1;
    if (valB == null || (typeof valB === "number" && !Number.isFinite(valB))) return -1;
    if (typeof valA === "string") {
      return state.sortDirection === "asc" ? valA.localeCompare(valB) : valB.localeCompare(valA);
    }
    return state.sortDirection === "asc" ? valA - valB : valB - valA;
  });

  for (let page = 0; page < pageCount; page++) appendNextPageRows();
}

function appendNextPageRows() {
  const tbody = document.getElementById("tableBody");
  if (!tbody) return;

  const start = (CURRENT_PAGE_INDEX - 1) * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, CURRENT_FILTERED_ITEMS.length);
  if (start >= CURRENT_FILTERED_ITEMS.length) return;

  const chunk = CURRENT_FILTERED_ITEMS.slice(start, end);
  const fragment = document.createDocumentFragment();

  chunk.forEach(item => {
    const tr = document.createElement("tr");
    tr.onclick = () => openStockModal(item);

    const diffVal = priceDifference(item);
    const diffPct = diffVal.toFixed(1);
    const isUp = diffVal > 0;
    const isDown = diffVal < 0;

    tr.innerHTML = `
      <td class="text-left">
        <div class="ticker-cell">
          <div>
            <div class="ticker-symbol">${escapeHtml(item.ticker)}</div>
            <div class="company-title">${escapeHtml(item.name)}</div>
          </div>
        </div>
      </td>
      <td class="col-sector text-left">${escapeHtml(item.sector)}</td>
      <td class="col-holders text-center">
        <span class="badge ${item.holders >= 5 ? 'fund-badge' : 'quarter-badge'}">
          ${escapeHtml(item.holdersDisplay || '1개사 보유')}
        </span>
      </td>
      <td class="text-center">
        <span class="action-badge ${escapeHtml(item.action)}">
          ${escapeHtml(item.action === 'NEW' ? 'NEW' : item.action)}
        </span>
      </td>
      <td class="col-shares text-right">${escapeHtml(item.shares)}</td>
      <td class="col-value text-right">${formatMoney(item.value)}</td>
      <td class="col-weight text-right">
        <strong>${item.weight}%</strong>
        <div class="weight-progress-bar">
          <div class="weight-progress-fill" style="width: ${Math.min(item.weight * 3, 100)}%"></div>
        </div>
      </td>
      <td class="col-estPrice text-right">${priceLabel(item.estPrice)}</td>
      <td class="col-curPrice text-right">
        <strong>${priceLabel(item.curPrice)}</strong><small>${escapeHtml(item.quoteAsOf || "시세 관측시각 미확인")}</small>
        ${Number.isFinite(item.priceChangePct) ? `<small class="${item.priceChangePct >= 0 ? 'text-green' : 'text-red'}">(${item.priceChangePct >= 0 ? '+' : ''}${item.priceChangePct}%)</small>` : ''}
      </td>
      <td class="col-discount text-right">
        ${(!Number.isFinite(diffVal) || item.action === 'PUT' || item.action === 'CALL' || item.isOption) ? `
          <span class="discount-val" style="color: var(--text-subdued);" title="${escapeHtml(priceComparisonReason(item))}">비교 보류</span>
        ` : `
          <span class="discount-val ${isUp ? 'positive' : (isDown ? 'discount' : '')}">
            ${isUp ? '+' : ''}${diffPct}%
          </span>
        `}
      </td>
    `;
    fragment.appendChild(tr);
  });

  tbody.appendChild(fragment);
  applyColumnVisibility();
  CURRENT_PAGE_INDEX++;
}

function applyColumnVisibility() {
  Object.keys(state.visibleColumns).forEach(col => {
    const isVisible = state.visibleColumns[col];
    const elements = document.querySelectorAll(`.col-${col}`);
    elements.forEach(el => {
      el.style.display = isVisible ? "" : "none";
    });
  });
}

// 기능 1 & 기능 4: 확장 종목 상세 모달 (보유 운용사 전체 명단 + 1년 변천사)
function openStockModal(item) {
  const modal = document.getElementById("stockModal");
  if (!modal) return;
  ACTIVE_STOCK_ITEM = item;
  ACTIVE_STOCK_GURU_KEY = Object.keys(GURU_DATABASE).find(key => (GURU_DATABASE[key].holdings || []).includes(item)) || state.currentGuruKey;
  applyLivePricesToHoldings([item]);
  document.getElementById("modalTicker").innerText = item.ticker;
  document.getElementById("modalName").innerText = item.name;
  document.getElementById("modalSector").innerText = item.sector;
  renderStockQuote(item);

  document.getElementById("modalWeight").innerText = `${item.weight}%`;
  document.getElementById("modalVal").innerText = formatMoney(item.value);
  document.getElementById("modalShares").innerText = `${item.shares} 주`;
  document.getElementById("modalEstPrice").innerText = `${priceLabel(item.estPrice)}`;
  
  const elInsight = document.getElementById("modalInsightText");
  if (elInsight) elInsight.innerText = item.insight || "이 종목은 주요 운용사들의 포트폴리오에 편입된 핵심 자산입니다.";

  // 기능 4: 1년 비중 변천사 타임라인 렌더링
  renderStockHistoryTimeline(item);

  // 기능 1: 100대 운용사 중 이 종목을 보유한 전체 명단 추출 & 렌더링
  renderStockHoldersTable(item);

  // [NEW] 최근 경영진 내부자 거래 (Form 4) 교차 분석 렌더링
  renderModalInsiderCross(item);

  // 외부 파이낸스 링크 세팅
  const isMapped = !/^(CUSIP:|UNMAPPED:)/.test(item.baseTicker || item.ticker || "");
  let cleanTicker = (item.baseTicker || item.ticker || "").split(" ")[0].replace(/[^a-zA-Z0-9\-\.]/g, "");
  if (!cleanTicker || cleanTicker === "STOCK") {
    cleanTicker = (item.name || "").split(" ")[0].replace(/[^a-zA-Z0-9]/g, "");
  }

  const linkYahoo = document.getElementById("linkYahooFinance");
  if (linkYahoo) {
    const yTicker = cleanTicker.replace(".", "-");
    linkYahoo.hidden = !isMapped;
    linkYahoo.href = `https://finance.yahoo.com/quote/${yTicker}/`;
    linkYahoo.onclick = (e) => e.stopPropagation();
  }

  const linkGoogle = document.getElementById("linkGoogleFinance");
  if (linkGoogle) {
    linkGoogle.hidden = !isMapped;
    linkGoogle.href = `https://www.google.com/finance?q=${encodeURIComponent(cleanTicker)}`;
    linkGoogle.onclick = (e) => e.stopPropagation();
  }

  modal.classList.add("show");
}

function renderStockQuote(item) {
  document.getElementById('modalCurPrice').innerText = priceLabel(item.curPrice);
  document.getElementById('modalCurPrice').title = item.quoteAsOf || '시세 관측시각 미확인';
  const tag = document.getElementById('modalDiscountTag');
  if (tag) {
    tag.innerText = `${priceComparisonReason(item)} · ${item.quoteAsOf || '시세 관측시각 미확인'}`;
    tag.style.color = 'var(--text-subdued)';
  }
}

function renderStockHistoryTimeline(item) {
  const container = document.getElementById("modalHistoryTimeline");
  if (!container) return;
  container.innerHTML = "";

  const notice = document.createElement('p');
  notice.className = 'history-unavailable';
  notice.textContent = '검증된 과거 분기별 데이터가 없어 추이를 표시하지 않습니다.';
  container.appendChild(notice);
}

function renderStockHoldersTable(item) {
  const tbody = document.getElementById("modalHoldersBody");
  const countEl = document.getElementById("modalHoldersCount");
  if (!tbody || !countEl) return;
  tbody.innerHTML = "";

  const holders = [];

  Object.keys(GURU_DATABASE).forEach(guruKey => {
    if (guruKey === "__GRAND_TOTAL__" || guruKey === "__CUSTOM_GROUP__") return;
    const guru = GURU_DATABASE[guruKey];
    if (!guru || !guru.holdings) return;

    const match = guru.holdings.find(h => holdingIdentity(h) === holdingIdentity(item));
    if (match) {
      holders.push({
        guruKey: guruKey,
        fund: guru.fund || guru.name,
        manager: guru.name,
        shares: match.shares,
        val: match.value,
        weight: match.weight
      });
    }
  });

  holders.sort((a, b) => b.weight - a.weight);
  countEl.innerText = holders.length;

  if (holders.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 14px; color: var(--text-muted);">보유 정보가 없습니다.</td></tr>`;
    return;
  }

  holders.forEach(h => {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.onclick = () => {
      ++insiderRequestId;
      document.getElementById("stockModal").classList.remove("show");
      selectGuru(h.guruKey);
    };
    tr.innerHTML = `
      <td><strong>${escapeHtml(h.fund)}</strong></td>
      <td>${escapeHtml(h.manager)}</td>
      <td class="text-right">${escapeHtml(h.shares)}</td>
      <td class="text-right">${formatMoney(h.val)}</td>
      <td class="text-right text-green"><strong>${h.weight}%</strong></td>
    `;
    tbody.appendChild(tr);
  });
}

function setupEventListeners() {
  const btnGrand = document.getElementById("btnGrandTotal");
  if (btnGrand) {
    btnGrand.onclick = () => selectGuru("__GRAND_TOTAL__");
  }

  const btnCustom = document.getElementById("btnCustomGroup");
  if (btnCustom) {
    btnCustom.onclick = () => buildCustomGroupPortfolio();
  }

  const btnClose = document.getElementById("btnModalClose");
  if (btnClose) {
    btnClose.onclick = () => {
      ++insiderRequestId;
      document.getElementById("stockModal").classList.remove("show");
    };
  }



  document.querySelectorAll(".filter-tab").forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll(".filter-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      state.activeFilter = tab.dataset.filter;
      renderTable();
    };
  });

  const searchInput = document.getElementById("searchInput");
  if (searchInput) {
    searchInput.oninput = (e) => {
      state.searchQuery = e.target.value;
      renderTable();
    };
  }

  const btnToggleCols = document.getElementById("btnToggleCols");
  const colMenu = document.getElementById("colMenu");
  if (btnToggleCols && colMenu) {
    btnToggleCols.onclick = (e) => {
      e.stopPropagation();
      colMenu.style.display = colMenu.style.display === "flex" ? "none" : "flex";
    };

    document.addEventListener("click", () => {
      colMenu.style.display = "none";
    });

    colMenu.querySelectorAll("input[type='checkbox']").forEach(chk => {
      chk.onchange = (e) => {
        const col = e.target.dataset.col;
        state.visibleColumns[col] = e.target.checked;
        applyColumnVisibility();
      };
    });
  }

  document.querySelectorAll("th.sortable").forEach(th => {
    th.onclick = () => {
      const col = th.dataset.sort;
      if (state.sortColumn === col) {
        state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
      } else {
        state.sortColumn = col;
        state.sortDirection = "desc";
      }
      renderTable();
    };
  });

  const btnExport = document.getElementById("btnExportCsv");
  if (btnExport) {
    btnExport.onclick = () => {
      const guru = GURU_DATABASE[state.currentGuruKey];
      if (!guru || !guru.holdings) return;
      
      const csvContent = buildPartialCsv(guru);
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `Alpha13F_${guru.name.replace(/\s+/g, '_')}_Portfolio.csv`;
      link.click();
    };
  }

  const btnLogin = document.getElementById("btnGoogleLogin");
  if (btnLogin) btnLogin.onclick = () => loginWithGoogle();

  const btnLogout = document.getElementById("btnLogout");
  if (btnLogout) btnLogout.onclick = () => logout();

  // SEC 공식 공시 모드 선택 리스트 클릭 이벤트 (원클릭 전환)
  document.querySelectorAll(".filing-mode-item").forEach(btn => {
    btn.onclick = () => {
      const mode = btn.dataset.mode;
      if (mode) {
        switchFilingMode(mode);
      }
    };
  });

  // 하위 호환용 레거시 셀렉터 이벤트
  const filingSelector = document.getElementById("filingSelector");
  if (filingSelector) {
    filingSelector.onchange = (e) => {
      switchFilingMode(e.target.value);
    };
  }

  // Form 4 전용 필터 탭
  document.querySelectorAll("#f4FilterTabs .filter-tab").forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll("#f4FilterTabs .filter-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      state.f4Filter = tab.dataset.f4filter;
      renderForm4Table();
    };
  });

  // Form 4 검색바
  const f4Search = document.getElementById("f4SearchInput");
  if (f4Search) {
    f4Search.oninput = (e) => {
      state.f4Query = e.target.value.trim().toLowerCase();
      renderForm4Table();
    };
  }

  // 13D 전용 필터 탭
  document.querySelectorAll("#d13FilterTabs .filter-tab").forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll("#d13FilterTabs .filter-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      state.d13Filter = tab.dataset.d13filter;
      render13DTable();
    };
  });

  // 13D 검색바
  const d13Search = document.getElementById("d13SearchInput");
  if (d13Search) {
    d13Search.oninput = (e) => {
      state.d13Query = e.target.value.trim().toLowerCase();
      render13DTable();
    };
  }

  // 내부자 거래 모달 닫기 이벤트
  const btnCloseInsider = document.getElementById("btnInsiderModalClose");
  if (btnCloseInsider) {
    btnCloseInsider.onclick = () => closeInsiderModal();
  }

  const insiderModal = document.getElementById("insiderModal");
  if (insiderModal) {
    insiderModal.onclick = (e) => {
      if (e.target === insiderModal) closeInsiderModal();
    };
  }

  // 거시경제 펄스 바 & 모달 이벤트
  const pulseBar = document.getElementById("macroPulseBar");
  if (pulseBar) {
    pulseBar.onclick = () => openMacroModal();
  }

  const btnCloseMacro = document.getElementById("btnMacroModalClose");
  if (btnCloseMacro) {
    btnCloseMacro.onclick = () => closeMacroModal();
  }

  const macroModal = document.getElementById("macroModal");
  if (macroModal) {
    macroModal.onclick = (e) => {
      if (e.target === macroModal) closeMacroModal();
    };
  }

  // 거시경제 캘린더 필터 탭 이벤트
  document.querySelectorAll("#macroCalFilterWrap .filter-tab").forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll("#macroCalFilterWrap .filter-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      state.macroCalFilter = tab.dataset.calfilter;
      renderMacroCalendar();
    };
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeInsiderModal();
      closeMacroModal();
    }
  });

  // 13F 및 Form 4 무한 스크롤(Infinite Scroll) 통합 핸들러
  const handleTableInfiniteScroll = () => {
    const mc = document.querySelector(".main-content");
    const isBottom = mc 
      ? (mc.scrollTop + mc.clientHeight >= mc.scrollHeight - 400)
      : (window.innerHeight + window.scrollY >= document.body.offsetHeight - 400);

    if (isBottom) {
      if (state.currentFilingType === "13F") {
        appendNextPageRows();
      } else if (state.currentFilingType === "FORM4") {
        appendNextF4PageRows();
      }
    }
  };

  const mainContentEl = document.querySelector(".main-content");
  if (mainContentEl) {
    mainContentEl.addEventListener("scroll", handleTableInfiniteScroll);
  }
  window.addEventListener("scroll", handleTableInfiniteScroll);
}

// ==============================================================================
// SEC Multi-Filing Suite Engine (Form 13F / Form 4 / Schedule 13D / 13G)
// ==============================================================================

let FORM4_DATA = [];
let FILING_13D_DATA = [];

state.currentFilingType = "13F";
state.f4Filter = "ALL";
state.f4Query = "";
state.d13Filter = "ALL";
state.d13Query = "";
state.selectedF4Ticker = null;
state.isF4FavGroupActive = false;
state.f4SidebarSearchQuery = "";
state.f4FavCompanies = JSON.parse(localStorage.getItem("alpha13f_f4_fav_tickers") || "[]");

function saveF4Favs() {
  localStorage.setItem("alpha13f_f4_fav_tickers", JSON.stringify(state.f4FavCompanies));
}

async function switchFilingMode(filingType) {
  state.currentFilingType = filingType;

  // 사이드바 공시 모드 리스트 활성화 상태 UI 동기화
  document.querySelectorAll(".filing-mode-item").forEach(btn => {
    const isActive = (btn.dataset.mode === filingType);
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  // 모바일 하단 플로팅 네비게이션 바 동기화
  const bottomNav = document.getElementById("mobileBottomNav");
  if (bottomNav) {
    bottomNav.querySelectorAll(".mobile-nav-item[data-mode]").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.mode === filingType);
    });
  }

  // 모바일 상단 퀵 헤더 타이틀 동기화
  const mobileBrandH2 = document.querySelector(".mobile-brand-title h2");
  if (mobileBrandH2) {
    if (filingType === "13F") mobileBrandH2.innerHTML = 'ALPHA <span>13F</span>';
    else if (filingType === "FORM4") mobileBrandH2.innerHTML = 'ALPHA <span>INSIDER</span>';
    else if (filingType === "13D") mobileBrandH2.innerHTML = 'ALPHA <span>13D</span>';
    else if (filingType === "13G") mobileBrandH2.innerHTML = 'ALPHA <span>13G</span>';
    else if (filingType === "MACRO") mobileBrandH2.innerHTML = 'ALPHA <span>MACRO</span>';
  }

  // 하위 호환용 숨김 셀렉트 값 동기화
  const legacySel = document.getElementById("filingSelector");
  if (legacySel && legacySel.value !== filingType) {
    legacySel.value = filingType;
  }
  
  const brandTitle = document.getElementById("brandTitle");
  const brandSubtitle = document.getElementById("brandSubtitle");
  const headerName = document.getElementById("currentGuruName");
  const headerFund = document.getElementById("currentFundName");
  const headerQuarter = document.getElementById("currentQuarter");
  const headerDesc = document.getElementById("currentGuruDesc");

  const ctrl13F = document.getElementById("sidebarControls13F");
  const ctrlF4 = document.getElementById("sidebarControlsForm4");

  const v13F = document.getElementById("view13F");
  const vF4 = document.getElementById("viewForm4");
  const v13D = document.getElementById("view13D");
  const vMacro = document.getElementById("viewMacro");

  if (v13F) v13F.style.display = "none";
  if (vF4) vF4.style.display = "none";
  if (v13D) v13D.style.display = "none";
  if (vMacro) vMacro.style.display = "none";

  if (filingType === "13F") {
    if (brandTitle) brandTitle.innerHTML = 'ALPHA <span>13F</span>';
    if (brandSubtitle) brandSubtitle.innerText = '운용사 포트폴리오 분석';
    if (ctrl13F) ctrl13F.style.display = "flex";
    if (ctrlF4) ctrlF4.style.display = "none";
    if (v13F) v13F.style.display = "flex";
    selectGuru(state.currentGuruKey || "__GRAND_TOTAL__");
  } else if (filingType === "FORM4") {
    if (brandTitle) brandTitle.innerHTML = 'ALPHA <span>INSIDER</span>';
    if (brandSubtitle) brandSubtitle.innerText = '실시간 내부자 거래 추적 (Form 4)';
    if (ctrl13F) ctrl13F.style.display = "none";
    if (ctrlF4) ctrlF4.style.display = "flex";
    if (vF4) vF4.style.display = "flex";
    await loadAndRenderForm4();
  } else if (filingType === "13D") {
    if (brandTitle) brandTitle.innerHTML = 'ALPHA <span>13D</span>';
    if (brandSubtitle) brandSubtitle.innerText = '행동주의 5% 지분 공시 (Schedule 13D)';
    if (headerName) headerName.innerText = 'Schedule 13D 행동주의 지분 취득 공시';
    if (headerFund) headerFund.innerText = '지분 5% 이상 적극적 경영 참여';
    if (headerQuarter) headerQuarter.innerText = '취득 후 10일 이내 공시';
    if (headerDesc) headerDesc.innerText = '거물 헤지펀드(칼 아이칸, 빌 애크먼, 넬슨 펠츠 등)의 경영권 분쟁, 주주 제안, M&A 압박 지분 포착';
    if (ctrl13F) ctrl13F.style.display = "flex";
    if (ctrlF4) ctrlF4.style.display = "none";
    if (v13D) v13D.style.display = "flex";
    state.d13Filter = "13D";
    const tab13D = document.querySelector('[data-d13filter="13D"]');
    if (tab13D) {
      document.querySelectorAll("#d13FilterTabs .filter-tab").forEach(t => t.classList.remove("active"));
      tab13D.classList.add("active");
    }
    await loadAndRender13D();
  } else if (filingType === "13G") {
    if (brandTitle) brandTitle.innerHTML = 'ALPHA <span>13G</span>';
    if (brandSubtitle) brandSubtitle.innerText = '단순 대량 보유 5% 공시 (Schedule 13G)';
    if (headerName) headerName.innerText = 'Schedule 13G 단순 대량 보유 공시';
    if (headerFund) headerFund.innerText = '지분 5% 이상 패시브 투자';
    if (headerQuarter) headerQuarter.innerText = '패시브 기관 대량 지분 공시';
    if (headerDesc) headerDesc.innerText = '블랙록, 뱅가드 등 초대형 기관 투자자의 5% 이상 단순 수동적 지분 보유 내역 추적';
    if (ctrl13F) ctrl13F.style.display = "flex";
    if (ctrlF4) ctrlF4.style.display = "none";
    if (v13D) v13D.style.display = "flex";
    state.d13Filter = "13G";
    const tab13G = document.querySelector('[data-d13filter="13G"]');
    if (tab13G) {
      document.querySelectorAll("#d13FilterTabs .filter-tab").forEach(t => t.classList.remove("active"));
      tab13G.classList.add("active");
    }
    await loadAndRender13D();
  } else if (filingType === "MACRO") {
    if (brandTitle) brandTitle.innerHTML = 'ALPHA <span>MACRO</span>';
    if (brandSubtitle) brandSubtitle.innerText = '거시경제 & FOMC 나침반';
    if (headerName) headerName.innerText = 'Macro Compass (거시경제 & FOMC 캘린더)';
    if (headerFund) headerFund.innerText = '연준 금리 · 물가(CPI) · 고용(NFP) · 국채 수익률';
    if (headerQuarter) headerQuarter.innerText = '실시간 공식 데이터 연동';
    if (headerDesc) headerDesc.innerText = '미 뉴욕 연준(FRBNY), 미 노동통계국(BLS) 공식 지표 및 국채 수익률 곡선을 확인된 SEC 공시 부분집합와 입체적으로 연계 분석합니다.';
    if (ctrl13F) ctrl13F.style.display = "none";
    if (ctrlF4) ctrlF4.style.display = "none";
    if (vMacro) vMacro.style.display = "block";
    await loadAndRenderMacro();
    fetchLivePricesForCurrentView();
  }
}

function getF4ActiveDataset() {
  if (state.selectedF4Ticker) {
    return FORM4_DATA.filter(item => item.ticker === state.selectedF4Ticker);
  }
  if (state.isF4FavGroupActive && state.f4FavCompanies.length > 0) {
    return FORM4_DATA.filter(item => state.f4FavCompanies.includes(item.ticker));
  }
  return FORM4_DATA;
}

async function loadAndRenderForm4() {
  if (FORM4_DATA.length === 0) {
    try {
      const res = await fetch("latest_form4_insiders.json?v=" + Date.now());
      if (res.ok) {
        FORM4_DATA = await res.json();
      }
    } catch (e) {
      console.warn("Form 4 로드 실패:", e);
    }
  }

  // 좌측 105개 상장사 사이드바 렌더링
  renderF4SidebarCompanyList();

  // 상단 헤더 동기화
  const headerName = document.getElementById("currentGuruName");
  const headerFund = document.getElementById("currentFundName");
  const headerQuarter = document.getElementById("currentQuarter");
  const headerDesc = document.getElementById("currentGuruDesc");

  const dataset = getF4ActiveDataset();

  if (state.selectedF4Ticker) {
    const compFirst = dataset[0] || {};
    const compName = compFirst.companyName || state.selectedF4Ticker;
    if (headerName) headerName.innerText = `${compName} (${state.selectedF4Ticker})`;
    if (headerFund) headerFund.innerText = `최근 공시 ${dataset.length}건`;
    if (headerQuarter) headerQuarter.innerText = `SEC Form 4 내부자 거래`;
    if (headerDesc) headerDesc.innerText = `${compName}의 CEO, CFO, 이사회 등 핵심 경영진의 장내 매매 및 스톡옵션/보상 공시 내역`;
  } else if (state.isF4FavGroupActive) {
    if (headerName) headerName.innerText = `즐겨찾기 기업 내부자 거래 (${state.f4FavCompanies.length}개사)`;
    if (headerFund) headerFund.innerText = `찜한 기업 총 ${dataset.length}건 거래`;
    if (headerQuarter) headerQuarter.innerText = `즐겨찾기 묶어보기`;
    if (headerDesc) headerDesc.innerText = `내가 즐겨찾기한 ${state.f4FavCompanies.join(", ")}의 최근 내부자 거래 통합 현황`;
  } else {
    if (headerName) headerName.innerText = 'Form 4 실시간 내부자 거래 (Insider Trading)';
    if (headerFund) headerFund.innerText = '105개 주요 상장사 CEO·임원 장내 거래';
    if (headerQuarter) headerQuarter.innerText = '거래 후 2영업일 이내 공시';
    if (headerDesc) headerDesc.innerText = '경영진 및 이사회, 10% 이상 대주주의 법적 의무 공시 Form 4 장내 직접 매수·매도 실시간 추적';
  }

  // 상단 4대 통계 카드 계산
  const totalVal = dataset.reduce((sum, item) => sum + (item.totalValue || 0), 0);
  const buyItems = dataset.filter(item => item.txTypeCode === "P");
  const saleItems = dataset.filter(item => item.txTypeCode === "S");
  const officerItems = dataset.filter(item => item.isOfficer);

  const tickerMap = {};
  dataset.forEach(item => {
    tickerMap[item.ticker] = (tickerMap[item.ticker] || 0) + (item.totalValue || 0);
  });
  let topTicker = "-";
  let maxTickerVal = 0;
  for (const [t, v] of Object.entries(tickerMap)) {
    if (v > maxTickerVal) {
      maxTickerVal = v;
      topTicker = t;
    }
  }

  const maxTradeItem = dataset.reduce((max, item) => (item.totalValue > (max ? max.totalValue : 0) ? item : max), null);

  const elTotVal = document.getElementById("f4MetricTotalVal");
  if (elTotVal) elTotVal.innerText = formatMoney(totalVal);

  const elTotCount = document.getElementById("f4MetricTotalCount");
  if (elTotCount) elTotCount.innerText = `총 ${dataset.length}건 공시 거래`;

  const elTopTicker = document.getElementById("f4MetricTopTicker");
  if (elTopTicker) elTopTicker.innerText = state.selectedF4Ticker ? state.selectedF4Ticker : topTicker;

  const elTopTickerSub = document.getElementById("f4MetricTopTickerSub");
  if (elTopTickerSub) elTopTickerSub.innerText = `거래 대금 ${formatMoney(maxTickerVal)}`;

  const elBuyCount = document.getElementById("f4MetricBuyCount");
  if (elBuyCount) elBuyCount.innerText = `${buyItems.length}건 매수`;

  const elMaxTrade = document.getElementById("f4MetricMaxTrade");
  if (elMaxTrade && maxTradeItem) {
    elMaxTrade.innerText = `${maxTradeItem.ticker} (${formatMoney(maxTradeItem.totalValue)})`;
  } else if (elMaxTrade) {
    elMaxTrade.innerText = "-";
  }

  const elMaxTradeSub = document.getElementById("f4MetricMaxTradeSub");
  if (elMaxTradeSub && maxTradeItem) {
    elMaxTradeSub.innerText = `${maxTradeItem.insiderName} (${maxTradeItem.officerTitle})`;
  } else if (elMaxTradeSub) {
    elMaxTradeSub.innerText = "-";
  }

  // 필터 카운트
  const elCntAll = document.getElementById("f4CountAll");
  if (elCntAll) elCntAll.innerText = dataset.length;
  const elCntBuy = document.getElementById("f4CountBuy");
  if (elCntBuy) elCntBuy.innerText = buyItems.length;
  const elCntSale = document.getElementById("f4CountSale");
  if (elCntSale) elCntSale.innerText = saleItems.length;
  const elCntOff = document.getElementById("f4CountOfficer");
  if (elCntOff) elCntOff.innerText = officerItems.length;

  renderForm4Table();
}

function renderF4SidebarCompanyList() {
  const container = document.getElementById("f4CompanyList");
  if (!container) return;
  container.innerHTML = "";

  // 105개 상장사 통계 집계
  const compMap = {};
  FORM4_DATA.forEach(item => {
    if (!compMap[item.ticker]) {
      compMap[item.ticker] = {
        ticker: item.ticker,
        name: item.companyName,
        count: 0,
        totalVal: 0
      };
    }
    compMap[item.ticker].count += 1;
    compMap[item.ticker].totalVal += (item.totalValue || 0);
  });

  let comps = Object.values(compMap);

  // 상단 레이블 카운트 동기화
  const labelEl = document.getElementById("f4CompanyListLabel");
  if (labelEl) {
    labelEl.innerText = `개별 기업 선택 (${comps.length}개사)`;
  }

  // 검색어 필터
  if (state.f4SidebarSearchQuery) {
    const q = state.f4SidebarSearchQuery.toLowerCase();
    comps = comps.filter(c => c.ticker.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
  }

  // 메인 상단 버튼 상태 동기화
  const btnAll = document.getElementById("btnF4AllCompanies");
  const btnFav = document.getElementById("btnF4FavCompanies");
  const subFav = document.getElementById("f4FavGroupSubtext");

  if (btnAll) {
    if (!state.selectedF4Ticker && !state.isF4FavGroupActive) {
      btnAll.classList.add("active");
    } else {
      btnAll.classList.remove("active");
    }
    btnAll.onclick = () => {
      state.selectedF4Ticker = null;
      state.isF4FavGroupActive = false;
      loadAndRenderForm4();
    };
  }

  if (btnFav) {
    if (state.f4FavCompanies.length > 0) {
      btnFav.style.display = "block";
      if (subFav) subFav.innerText = `${state.f4FavCompanies.length}개 기업 거래 합산`;
      if (state.isF4FavGroupActive) {
        btnFav.classList.add("active");
      } else {
        btnFav.classList.remove("active");
      }
      btnFav.onclick = () => {
        state.selectedF4Ticker = null;
        state.isF4FavGroupActive = true;
        loadAndRenderForm4();
      };
    } else {
      btnFav.style.display = "none";
      if (state.isF4FavGroupActive) {
        state.isF4FavGroupActive = false;
      }
    }
  }

  // 사이드바 검색 인풋 이벤트
  const sbSearch = document.getElementById("f4SidebarSearch");
  if (sbSearch) {
    sbSearch.oninput = (e) => {
      state.f4SidebarSearchQuery = e.target.value.trim();
      renderF4SidebarCompanyList();
    };
  }

  // 개별 기업 렌더링 헬퍼 함수
  const renderRow = (c) => {
    const isSelected = state.selectedF4Ticker === c.ticker;
    const isFav = state.f4FavCompanies.includes(c.ticker);

    const row = document.createElement("div");
    row.className = "guru-row-item";

    // 좌측 즐겨찾기 별표 버튼
    const starBtn = document.createElement("button");
    starBtn.className = `star-btn ${isFav ? 'starred' : ''}`;
    starBtn.innerHTML = isFav ? "★" : "☆";
    starBtn.title = isFav ? "즐겨찾기 해제" : "즐겨찾기 추가";
    starBtn.onclick = (e) => {
      e.stopPropagation();
      if (state.f4FavCompanies.includes(c.ticker)) {
        state.f4FavCompanies = state.f4FavCompanies.filter(t => t !== c.ticker);
      } else {
        state.f4FavCompanies.push(c.ticker);
      }
      saveF4Favs();
      renderF4SidebarCompanyList();
      if (state.isF4FavGroupActive) {
        loadAndRenderForm4();
      }
    };
    row.appendChild(starBtn);

    // 우측 기업 카드 버튼
    const btn = document.createElement("button");
    btn.className = `guru-card-btn ${isSelected ? 'active' : ''}`;
    btn.onclick = () => {
      state.selectedF4Ticker = c.ticker;
      state.isF4FavGroupActive = false;
      loadAndRenderForm4();
    };

    const initials = c.ticker.slice(0, 2);
    btn.innerHTML = `
      <div class="guru-mini-avatar">${escapeHtml(initials)}</div>
      <div class="guru-card-info" style="flex: 1; min-width: 0;">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 4px;">
          <h4 style="margin: 0; font-size: 13px; font-weight: 700; color: var(--text-base);">${escapeHtml(c.ticker)}</h4>
          <span style="font-size: 10px; padding: 1px 5px; border-radius: 4px; background: rgba(0, 230, 118, 0.15); color: #00E676; font-weight: 700;">${c.count}건</span>
        </div>
        <p style="margin: 2px 0 0 0; font-size: 11px; color: var(--text-subdued); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(c.name)}</p>
      </div>
    `;

    row.appendChild(btn);
    container.appendChild(row);
  };

  // 즐겨찾기 목록과 일반 목록 분리
  const favList = comps.filter(c => state.f4FavCompanies.includes(c.ticker));
  const otherList = comps.filter(c => !state.f4FavCompanies.includes(c.ticker));

  favList.sort((a, b) => b.count - a.count || a.ticker.localeCompare(b.ticker));
  otherList.sort((a, b) => b.count - a.count || a.ticker.localeCompare(b.ticker));

  if (!state.f4SidebarSearchQuery && favList.length > 0) {
    // 1) 즐겨찾기 섹션 서브헤더
    const favHeader = document.createElement("div");
    favHeader.style.cssText = "font-size: 11px; font-weight: 700; color: #ffb300; padding: 6px 8px 4px; display: flex; align-items: center; gap: 5px;";
    favHeader.innerHTML = `<span>즐겨찾기 기업</span> <span style="font-size: 10px; opacity: 0.8; font-weight: 600;">(${favList.length}개)</span>`;
    container.appendChild(favHeader);

    favList.forEach(renderRow);

    // 2) 전체 상장사 섹션 서브헤더
    const otherHeader = document.createElement("div");
    otherHeader.style.cssText = "font-size: 11px; font-weight: 700; color: var(--text-subdued); padding: 12px 8px 4px; border-top: 1px dashed rgba(255,255,255,0.08); margin-top: 6px; display: flex; align-items: center; gap: 5px;";
    otherHeader.innerHTML = `<span>전체 상장사</span> <span style="font-size: 10px; opacity: 0.8; font-weight: 600;">(${otherList.length}개)</span>`;
    container.appendChild(otherHeader);

    otherList.forEach(renderRow);
  } else {
    // 검색 중이거나 즐겨찾기가 없는 경우
    const sorted = [...favList, ...otherList];
    sorted.forEach(renderRow);
  }
}

let CURRENT_F4_FILTERED_ITEMS = [];
let CURRENT_F4_PAGE_INDEX = 1;
const F4_PAGE_SIZE = 80;

function renderForm4Table() {
  const tbody = document.getElementById("f4TableBody");
  if (!tbody) return;
  tbody.innerHTML = "";
  CURRENT_F4_PAGE_INDEX = 1;

  let list = getF4ActiveDataset();

  if (state.f4Filter === "BUY") {
    list = list.filter(item => item.txTypeCode === "P");
  } else if (state.f4Filter === "SALE") {
    list = list.filter(item => item.txTypeCode === "S");
  } else if (state.f4Filter === "OFFICER") {
    list = list.filter(item => item.isOfficer);
  }

  if (state.f4Query) {
    list = list.filter(item => 
      item.ticker.toLowerCase().includes(state.f4Query) ||
      item.companyName.toLowerCase().includes(state.f4Query) ||
      item.insiderName.toLowerCase().includes(state.f4Query)
    );
  }

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="text-center" style="padding: 40px; color: var(--text-muted);">조건에 일치하는 Form 4 내부자 거래 공시가 없습니다.</td></tr>`;
    return;
  }

  CURRENT_F4_FILTERED_ITEMS = list;
  appendNextF4PageRows();
}

function appendNextF4PageRows() {
  const tbody = document.getElementById("f4TableBody");
  if (!tbody || !CURRENT_F4_FILTERED_ITEMS || CURRENT_F4_FILTERED_ITEMS.length === 0) return;

  const start = (CURRENT_F4_PAGE_INDEX - 1) * F4_PAGE_SIZE;
  const end = Math.min(start + F4_PAGE_SIZE, CURRENT_F4_FILTERED_ITEMS.length);
  if (start >= CURRENT_F4_FILTERED_ITEMS.length) return;

  const chunk = CURRENT_F4_FILTERED_ITEMS.slice(start, end);
  const fragment = document.createDocumentFragment();

  chunk.forEach(item => {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.onclick = (e) => {
      if (e.target.closest("a")) return;
      openInsiderModal(item.ticker, item.companyName);
    };

    let txBadgeClass = "action-badge badge-f4-etc";
    if (item.txTypeCode === "P") txBadgeClass = "action-badge badge-f4-buy";
    else if (item.txTypeCode === "S") txBadgeClass = "action-badge badge-f4-sale";
    else if (item.txTypeCode === "M" || item.txTypeCode === "C") txBadgeClass = "action-badge badge-f4-option";
    else if (item.txTypeCode === "A") txBadgeClass = "action-badge badge-f4-award";
    else if (item.txTypeCode === "G") txBadgeClass = "action-badge badge-f4-gift";
    else if (item.txTypeCode === "F") txBadgeClass = "action-badge badge-f4-tax";

    const formattedShares = item.shares ? Number(item.shares).toLocaleString(undefined, { maximumFractionDigits: 1 }) : "-";
    const formattedPrice = item.price > 0 ? `$${Number(item.price).toFixed(2)}` : "$0.00";
    const formattedVal = item.totalValue > 0 ? formatMoney(item.totalValue) : "$0";
    const formattedPost = item.postShares > 0 ? Number(item.postShares).toLocaleString(undefined, { maximumFractionDigits: 0 }) : "-";

    tr.innerHTML = `
      <td class="text-left font-mono" style="font-size: 12px; color: var(--text-secondary);">${escapeHtml(item.filingDate)}</td>
      <td class="text-left font-semibold" title="${escapeHtml(item.ticker)} - ${escapeHtml(item.companyName)}">
        <div style="display: flex; align-items: baseline; gap: 6px; overflow: hidden;">
          <span style="color: #fff; font-weight: 800; font-size: 13px; flex-shrink: 0;">${escapeHtml(item.ticker)}</span>
          <span style="font-size: 11.5px; color: var(--text-muted); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(item.companyName)}</span>
        </div>
      </td>
      <td class="text-left font-medium" style="color: var(--accent-blue);" title="${escapeHtml(item.insiderName)}">${escapeHtml(item.insiderName)}</td>
      <td class="text-left" style="font-size: 12px; color: var(--text-secondary);" title="${escapeHtml(item.officerTitle)}">${escapeHtml(item.officerTitle)}</td>
      <td class="text-center"><span class="${txBadgeClass}">${escapeHtml(item.txType)}</span></td>
      <td class="text-right font-mono font-medium">${formattedShares} 주</td>
      <td class="text-right font-mono">${formattedPrice}</td>
      <td class="text-right font-mono font-bold" style="color: ${item.txTypeCode === 'P' ? '#00E676' : (item.txTypeCode === 'S' ? '#FF5252' : '#fff')};">${formattedVal}</td>
      <td class="text-right font-mono" style="color: var(--text-muted); font-size: 12px;">${formattedPost}</td>
      <td class="text-center">
        <a href="${escapeHtml(safeSecUrl(item.secUrl))}" target="_blank" rel="noopener noreferrer" class="sec-link-btn" title="SEC 공식 원문 공시 보기" onclick="event.stopPropagation();" style="display: inline-flex; align-items: center; padding: 2px 6px; border-radius: 4px; background: rgba(255,255,255,0.06); color: #00E676; font-size: 11px; text-decoration: none; border: 1px solid rgba(0,230,118,0.2);">
          원문 ↗
        </a>
      </td>
    `;
    fragment.appendChild(tr);
  });

  tbody.appendChild(fragment);
  CURRENT_F4_PAGE_INDEX++;
}

function openInsiderModal(ticker) {
  const modal = document.getElementById("insiderModal");
  if (!modal) return;

  const tickerItems = FORM4_DATA.filter(item => item.ticker === ticker);
  if (tickerItems.length === 0) return;

  const first = tickerItems[0];
  const elTicker = document.getElementById("insiderModalTicker");
  const elName = document.getElementById("insiderModalName");
  const elSector = document.getElementById("insiderModalSector");

  if (elTicker) elTicker.innerText = first.ticker;
  if (elName) elName.innerText = first.companyName;
  if (elSector) elSector.innerText = `${first.sector} · Form 4 내부자 거래 전수 히스토리`;

  // 통계 계산
  const buyItems = tickerItems.filter(item => item.txTypeCode === "P");
  const saleItems = tickerItems.filter(item => item.txTypeCode === "S");
  const totalVal = tickerItems.reduce((sum, item) => sum + (item.totalValue || 0), 0);

  const elCount = document.getElementById("insiderModalCount");
  if (elCount) elCount.innerText = `${tickerItems.length}건`;

  const elBuyCount = document.getElementById("insiderModalBuyCount");
  if (elBuyCount) elBuyCount.innerText = `${buyItems.length}건 (${formatMoney(buyItems.reduce((s, i) => s + i.totalValue, 0))})`;

  const elSaleCount = document.getElementById("insiderModalSaleCount");
  if (elSaleCount) elSaleCount.innerText = `${saleItems.length}건 (${formatMoney(saleItems.reduce((s, i) => s + i.totalValue, 0))})`;

  const elTotalVal = document.getElementById("insiderModalTotalVal");
  if (elTotalVal) elTotalVal.innerText = formatMoney(totalVal);

  // 테이블 렌더링
  const tbody = document.getElementById("insiderModalTableBody");
  if (tbody) {
    tbody.innerHTML = "";
    // 날짜순 내림차순 정렬
    const sorted = [...tickerItems].sort((a, b) => new Date(b.filingDate) - new Date(a.filingDate));
    
    sorted.forEach(item => {
      const isBuy = item.txTypeCode === "P";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(item.filingDate)}</td>
        <td><strong>${escapeHtml(item.insiderName)}</strong></td>
        <td><span style="font-size: 12px; color: var(--text-subdued);">${escapeHtml(item.officerTitle)}</span></td>
        <td class="text-center">
          <span class="badge-tx ${isBuy ? 'badge-tx-buy' : (insiderCode(item) === 'S' ? 'badge-tx-sale' : '')}">
            ${escapeHtml(insiderLabel(item))}
          </span>
        </td>
        <td class="text-right">${escapeHtml(item.shares.toLocaleString())} 주</td>
        <td class="text-right">$${item.price.toFixed(2)}</td>
        <td class="text-right text-green"><strong>${formatMoney(item.totalValue)}</strong></td>
        <td class="text-right">${escapeHtml(item.postShares.toLocaleString())} 주</td>
        <td class="text-center">
          <a href="${escapeHtml(safeSecUrl(item.secUrl))}" target="_blank" class="sec-doc-link">SEC 공시 ↗</a>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  // 외부 링크
  const secLink = document.getElementById("insiderModalSecLink");
  if (secLink) secLink.href = safeSecUrl(first.secUrl || 'https://www.sec.gov/edgar/searchedgar/companysearch');

  const yahooLink = document.getElementById("insiderModalYahooLink");
  if (yahooLink) yahooLink.href = `https://finance.yahoo.com/quote/${encodeURIComponent(first.ticker)}/insider-roster`;

  modal.classList.add("active");
  document.body.style.overflow = "hidden";
}

function closeInsiderModal() {
  const modal = document.getElementById("insiderModal");
  if (modal) {
    modal.classList.remove("active");
    document.body.style.overflow = "";
  }
}

async function loadAndRender13D() {
  if (FILING_13D_DATA.length === 0) {
    try {
      const res = await fetch("latest_13d_filings.json");
      if (res.ok) {
        FILING_13D_DATA = await res.json();
      }
    } catch (e) {
      console.warn("13D 로드 실패:", e);
    }
  }

  const activistItems = FILING_13D_DATA.filter(item => item.isActivist);
  const passiveItems = FILING_13D_DATA.filter(item => !item.isActivist);

  const elCnt = document.getElementById("d13MetricCount");
  if (elCnt) elCnt.innerText = `${FILING_13D_DATA.length}건`;

  const elActCnt = document.getElementById("d13MetricActivistCount");
  if (elActCnt) elActCnt.innerText = `${activistItems.length}건`;

  const elPassCnt = document.getElementById("d13MetricPassiveCount");
  if (elPassCnt) elPassCnt.innerText = `${passiveItems.length}건`;

  // 최다 공시 투자자
  const invMap = {};
  FILING_13D_DATA.forEach(item => {
    invMap[item.investorName] = (invMap[item.investorName] || 0) + 1;
  });
  let topInv = "-";
  let maxInvCnt = 0;
  for (const [k, v] of Object.entries(invMap)) {
    if (v > maxInvCnt) {
      maxInvCnt = v;
      topInv = k;
    }
  }
  const elTopInv = document.getElementById("d13MetricTopInvestor");
  if (elTopInv) elTopInv.innerText = topInv;

  const elTopInvSub = document.getElementById("d13MetricTopInvestorSub");
  if (elTopInvSub) elTopInvSub.innerText = `총 ${maxInvCnt}건 지분 공시 제출`;

  // 필터 카운트
  const elCntAll = document.getElementById("d13CountAll");
  if (elCntAll) elCntAll.innerText = FILING_13D_DATA.length;
  const elCnt13D = document.getElementById("d13Count13D");
  if (elCnt13D) elCnt13D.innerText = activistItems.length;
  const elCnt13G = document.getElementById("d13Count13G");
  if (elCnt13G) elCnt13G.innerText = passiveItems.length;

  render13DTable();
}

function render13DTable() {
  const tbody = document.getElementById("d13TableBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  let list = [...FILING_13D_DATA];

  if (state.d13Filter === "13D") {
    list = list.filter(item => item.isActivist);
  } else if (state.d13Filter === "13G") {
    list = list.filter(item => !item.isActivist);
  }

  if (state.d13Query) {
    const q = state.d13Query.toLowerCase().trim();
    list = list.filter(item =>
      (item.investorName && item.investorName.toLowerCase().includes(q)) ||
      (item.fundName && item.fundName.toLowerCase().includes(q)) ||
      (item.targetCompany && item.targetCompany.toLowerCase().includes(q)) ||
      (item.targetTicker && item.targetTicker.toLowerCase().includes(q))
    );
  }

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center" style="padding: 40px; color: var(--text-muted);">조건에 일치하는 13D/13G 공시가 없습니다.</td></tr>`;
    return;
  }

  list.forEach(item => {
    const tr = document.createElement("tr");
    
    // 지분율 포맷팅
    let pctDisplay = `<span style="color: var(--text-muted); font-size: 12px;">5%+</span>`;
    if (item.percentOwned !== null && item.percentOwned !== undefined) {
      const pctVal = typeof item.percentOwned === "number" ? item.percentOwned.toFixed(1) : item.percentOwned;
      const pctColor = item.isActivist ? '#c084fc' : '#60a5fa';
      pctDisplay = `<span style="font-size: 13px; font-weight: 700; color: ${pctColor};">${escapeHtml(pctVal)}%</span>`;
    }

    tr.innerHTML = `
      <td>${escapeHtml(item.filingDate)}</td>
      <td><strong style="color: var(--text-base);">${escapeHtml(item.formType)}</strong></td>
      <td>
        <div class="stock-name-cell">
          <span class="stock-ticker" style="font-size: 13px;">${escapeHtml(item.investorName)}</span>
          <span class="stock-company">${escapeHtml(item.fundName)}</span>
        </div>
      </td>
      <td>
        <div class="stock-name-cell">
          ${item.targetTicker ? `<span class="stock-ticker" style="font-size: 13px; color: var(--spotify-green);">${escapeHtml(item.targetTicker)}</span>` : ''}
          <span class="stock-company" style="font-weight: 600; color: var(--text-base);">${escapeHtml(item.targetCompany)}</span>
        </div>
      </td>
      <td class="text-center">
        ${pctDisplay}
      </td>
      <td class="text-center">
        <span class="badge-tx ${item.isActivist ? 'badge-activist' : 'badge-passive'}">
          ${item.isActivist ? '행동주의 13D' : '단순 대량 13G'}
        </span>
      </td>
      <td class="text-center">
        <a href="${escapeHtml(safeSecUrl(item.docUrl))}" target="_blank" class="sec-doc-link">SEC 원문 ↗</a>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// 백그라운드 프리페치 (탭 클릭 시 지연 없이 즉시 전환)
async function prefetchOtherFilings() {
  if (FORM4_DATA.length === 0) {
    try {
      const res = await fetch("latest_form4_insiders.json?v=" + Date.now());
      if (res.ok) FORM4_DATA = await res.json();
    } catch (e) {}
  }
  if (FILING_13D_DATA.length === 0) {
    try {
      const res = await fetch("latest_13d_filings.json?v=" + Date.now());
      if (res.ok) FILING_13D_DATA = await res.json();
    } catch (e) {}
  }
}

// ==============================================================================
// Macro Compass & Economic Pulse Engine (Fed Rates, BLS CPI/Labor, Calendar)
// ==============================================================================

let MACRO_DATA = null;
state.macroCalFilter = "ALL";

function renderMacroPulseBar() {
  const bar = document.getElementById("macroPulseBar");
  if (!bar || !MACRO_DATA) return;

  const fed = MACRO_DATA.fedRate || {};
  const cpi = MACRO_DATA.inflation || {};
  const spread = (MACRO_DATA.treasury && MACRO_DATA.treasury.spread10Y_13W) || {};
  const calendar = MACRO_DATA.calendar || [];
  const benchmarks = MACRO_DATA.benchmarks || {};

  const fedGap = benchmarks.fedRate?.gapToNeutral != null ? `(중립선 ${benchmarks.fedRate.gapToNeutral})` : "(비교 불가)";
  const cpiGap = benchmarks.inflation?.gapToTarget != null ? `(목표선 ${benchmarks.inflation.gapToTarget})` : "(비교 불가)";

  // 가장 임박한 주요 이벤트 찾기
  const nearestFedOrCritical = calendar.find(c => c.category === "FED" || c.impact === "CRITICAL") || calendar[0];

  const spreadValStr = Number.isFinite(spread.spread) ? (spread.spread >= 0 ? `+${spread.spread.toFixed(2)}%p` : `${spread.spread.toFixed(2)}%p`) : "확인 불가";

  let ddayBadgeHtml = "";
  if (nearestFedOrCritical) {
    const isFed = nearestFedOrCritical.category === "FED";
    const dotClass = isFed ? "red" : (nearestFedOrCritical.daysDiff <= 5 ? "orange" : "");
    ddayBadgeHtml = `
      <div class="macro-pulse-dday-badge ${isFed ? 'fed' : ''}" title="${escapeHtml(nearestFedOrCritical.name)} (${escapeHtml(nearestFedOrCritical.date)})">
        <span class="pulse-dot ${dotClass}"></span>
        <span>${escapeHtml(nearestFedOrCritical.dDay)} ${escapeHtml(nearestFedOrCritical.name.replace(/🏛️|미국\s*/g, '').trim())}</span>
      </div>
    `;
  }

  bar.innerHTML = `
    <div class="macro-pulse-left">
      <div class="macro-pulse-badge">
        <span class="pulse-dot"></span>
        <span>MACRO PULSE</span><small>${escapeHtml(macroFreshness(MACRO_DATA))}</small>
      </div>
      <div class="macro-pulse-items">
        <div class="macro-pulse-pill" title="연준 기준금리 및 장기 중립선(2.90%) 대비 갭">
          <span class="pill-label">연준 금리:</span>
          <span class="pill-val">${escapeHtml(fed.targetRange || "확인 불가")}</span>
          <span class="pill-sub" style="color: #ffa42b; font-size: 11px;">${escapeHtml(fedGap)}</span>
        </div>
        <div class="macro-pulse-sep"></div>
        <div class="macro-pulse-pill" title="미국 소비자물가(CPI) 및 법정 목표치(2.00%) 대비 갭">
          <span class="pill-label">CPI (YoY):</span>
          <span class="pill-val" style="color: #c084fc;">${escapeHtml(cpi.cpiYoY || "확인 불가")}</span>
          <span class="pill-sub" style="color: #c084fc; font-size: 11px;">${escapeHtml(cpiGap)}</span>
        </div>
        <div class="macro-pulse-sep"></div>
        <div class="macro-pulse-pill" title="10년물 국채 - 3개월물 T-Bill 금리 스프레드 (침체 역전선 0.00%p 기준)">
          <span class="pill-label">10Y-3M 스프레드:</span>
          <span class="pill-val" style="color: ${spread.spread >= 0 ? '#1ed760' : '#f3727f'};">${spreadValStr}</span>
          <span class="pill-sub">(${!Number.isFinite(spread.spread) ? '확인 불가' : spread.spread >= 0 ? '양의 스프레드' : '음의 스프레드'})</span>
        </div>
      </div>
    </div>
    <div class="macro-pulse-right">
      ${ddayBadgeHtml}
      <span class="macro-pulse-action">기준선 브리핑 ↗</span>
    </div>
  `;
}

async function loadAndRenderMacro() {
  if (!MACRO_DATA) {
    try {
      const res = await fetch("latest_macro_indicators.json?_t=" + Date.now());
      if (res.ok) MACRO_DATA = normalizeMacroData(await res.json());
    } catch (e) {
      console.warn("Macro data load error:", e);
    }
  }
  if (!MACRO_DATA) return;

  renderMacroPulseBar();

  // 1. 4대 요약 카드 렌더링 (공식 기준선과의 팩트 갭 표시)
  const fed = MACRO_DATA.fedRate || {};
  const cpi = MACRO_DATA.inflation || {};
  const labor = MACRO_DATA.labor || {};
  const treasury = MACRO_DATA.treasury || {};
  const spread = treasury.spread10Y_13W || {};
  const b = MACRO_DATA.benchmarks || {};

  const fedEl = document.getElementById("macroFedTarget");
  const fedSubEl = document.getElementById("macroFedSub");
  if (fedEl) fedEl.innerText = fed.targetRange || "확인 불가";
  if (fedSubEl) {
    const fedGap = b.fedRate?.gapToNeutral ?? "확인 불가";
    fedSubEl.innerText = `중립금리 참고값 대비 ${fedGap} · 실효금리(EFFR) ${fed.effr || "확인 불가"}`;
  }

  const cpiEl = document.getElementById("macroCpiVal");
  const cpiSubEl = document.getElementById("macroCpiSub");
  if (cpiEl) cpiEl.innerText = cpi.cpiYoY || "확인 불가";
  if (cpiSubEl) {
    const cpiGap = b.inflation?.gapToTarget ?? "확인 불가";
    cpiSubEl.innerText = `물가목표 참고값 대비 ${cpiGap} 상회`;
  }

  const unempEl = document.getElementById("macroUnemploymentVal");
  const unempSubEl = document.getElementById("macroUnemploymentSub");
  if (unempEl) unempEl.innerText = labor.unemploymentRate || "확인 불가";
  if (unempSubEl) unempSubEl.innerText = `관측 시점과 출처를 확인하세요`;

  const spreadEl = document.getElementById("macroSpreadVal");
  const spreadSubEl = document.getElementById("macroSpreadSub");
  const spreadVal = Number.isFinite(spread.spread) ? spread.spread : NaN;
  if (spreadEl) {
    spreadEl.innerText = !Number.isFinite(spreadVal) ? "확인 불가" : spreadVal >= 0 ? `+${spreadVal.toFixed(2)}%p` : `${spreadVal.toFixed(2)}%p`;
    spreadEl.className = `metric-value ${spreadVal >= 0 ? 'text-green' : 'text-red'}`;
  }
  if (spreadSubEl) {
    spreadSubEl.innerText = !Number.isFinite(spreadVal) ? "비교 불가" : spreadVal >= 0 
      ? `뉴욕 연준 침체 역전선(0.00%p) 상회 (+${spreadVal.toFixed(2)}%p)` 
      : `침체 역전선(0.00%p) 하회 (경기침체 경고 구간)`;
  }

  // 2. 공식 기준선 팩트 대조 카드 렌더링
  renderMacroBenchmarks();

  // 3. 거시 시각화 차트 렌더링 (수익률 곡선 SVG & 5대 기준선 계량 갭 차트)
  renderMacroCharts();

  // 4. 시장 프록시 그리드 렌더링
  renderMacroMarketProxies();

  // 5. 거시경제 캘린더 & D-Day 렌더링
  renderMacroCalendar();
}

function renderMacroBenchmarks() {
  const container = document.getElementById('macroBenchmarkGrid');
  if (container) container.textContent = '고정 예시값 기반 기준선 해석은 표시하지 않습니다. 실제 관측 지표와 출처를 확인하세요.';
}

let macroChartState = {
  yieldPeriod: '6M',
  spreadPeriod: '6M'
};

function getFilteredTreasuryData(period) {
  if (!MACRO_DATA || !MACRO_DATA.timeSeries || !Array.isArray(MACRO_DATA.timeSeries.treasuryDaily)) {
    return [];
  }
  const list = MACRO_DATA.timeSeries.treasuryDaily.filter(d => typeof d.date === "string" && [d.y3m, d.y5y, d.y10y, d.spread].every(Number.isFinite));
  if (!list.length) return [];
  let count = list.length;
  if (period === '1M') count = 21;
  else if (period === '3M') count = 63;
  else if (period === '6M') count = 126;
  else if (period === '1Y') count = list.length;
  return list.slice(-count);
}

function renderMacroCharts() {
  if (!MACRO_DATA) return;
  renderYieldTimeSeriesChart(macroChartState.yieldPeriod);
  renderSpreadTimeSeriesChart(macroChartState.spreadPeriod);
  initMacroChartTabEvents();
  setupMacroChartResize();
}

let macroResizeObserver = null;
function setupMacroChartResize() {
  if (macroResizeObserver) return;
  if (typeof ResizeObserver === "undefined") return;

  const c1 = document.getElementById("yieldTimeSeriesContainer");
  const c2 = document.getElementById("spreadTimeSeriesContainer");
  if (!c1 && !c2) return;

  let rafId = null;
  macroResizeObserver = new ResizeObserver(() => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      const vMacro = document.getElementById("viewMacro");
      if (vMacro && vMacro.style.display !== "none" && c1 && c1.clientWidth > 50) {
        renderYieldTimeSeriesChart(macroChartState.yieldPeriod);
        renderSpreadTimeSeriesChart(macroChartState.spreadPeriod);
      }
    });
  });

  if (c1) macroResizeObserver.observe(c1);
  if (c2) macroResizeObserver.observe(c2);
}

function initMacroChartTabEvents() {
  const yieldTabs = document.querySelectorAll("#yieldPeriodTabs .period-btn");
  yieldTabs.forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      yieldTabs.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      macroChartState.yieldPeriod = btn.dataset.period;
      renderYieldTimeSeriesChart(macroChartState.yieldPeriod);
    };
  });

  const spreadTabs = document.querySelectorAll("#spreadPeriodTabs .period-btn");
  spreadTabs.forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      spreadTabs.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      macroChartState.spreadPeriod = btn.dataset.period;
      renderSpreadTimeSeriesChart(macroChartState.spreadPeriod);
    };
  });
}

function renderYieldTimeSeriesChart(period = '6M') {
  const container = document.getElementById("yieldTimeSeriesContainer");
  if (!container || !MACRO_DATA) return;

  ["legendY3M", "legendY5Y", "legendY10Y"].forEach(id => { const el = document.getElementById(id); if (el) el.innerText = "-"; });
  const data = getFilteredTreasuryData(period);
  if (!data.length) {
    container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#888;font-size:12px;">국채 시계열 데이터가 없습니다.</div>`;
    return;
  }

  const latest = data[data.length - 1];
  const legY3M = document.getElementById("legendY3M");
  const legY5Y = document.getElementById("legendY5Y");
  const legY10Y = document.getElementById("legendY10Y");
  if (legY3M && typeof latest.y3m === 'number') legY3M.innerText = `${latest.y3m.toFixed(2)}%`;
  if (legY5Y && typeof latest.y5y === 'number') legY5Y.innerText = `${latest.y5y.toFixed(2)}%`;
  if (legY10Y && typeof latest.y10y === 'number') legY10Y.innerText = `${latest.y10y.toFixed(2)}%`;

  // 컨테이너 실제 픽셀 크기 측정 (비정상 가로 늘어남/왜곡 방지)
  const width = Math.max(container.clientWidth || 560, 320);
  const height = Math.max(container.clientHeight || 248, 180);

  const padL = 48, padR = 20, padT = 20, padB = 28;
  const chartW = width - padL - padR;
  const chartH = height - padT - padB;

  const allY = data.flatMap(d => [d.y3m, d.y5y, d.y10y]).filter(v => typeof v === 'number' && !isNaN(v));
  const minVal = Math.min(...allY);
  const maxVal = Math.max(...allY);
  const minY = Math.max(0, Math.floor((minVal - 0.15) * 2) / 2);
  const maxY = Math.ceil((maxVal + 0.15) * 2) / 2;
  const rangeY = Math.max(maxY - minY, 0.6);

  const getX = (i) => padL + (i / Math.max(data.length - 1, 1)) * chartW;
  const getY = (val) => padT + chartH - ((val - minY) / rangeY) * chartH;

  const steps = 4;
  let gridSvg = '';
  for (let s = 0; s <= steps; s++) {
    const tickVal = minY + (rangeY * s) / steps;
    const tickY = getY(tickVal);
    gridSvg += `
      <line x1="${padL}" y1="${tickY.toFixed(1)}" x2="${padL + chartW}" y2="${tickY.toFixed(1)}" stroke="rgba(255,255,255,0.06)" stroke-width="1" ${s > 0 && s < steps ? 'stroke-dasharray="3,3"' : ''} />
      <text x="${padL - 8}" y="${(tickY + 3.5).toFixed(1)}" fill="#8e8e93" font-size="10" font-weight="500" text-anchor="end">${tickVal.toFixed(1)}%</text>
    `;
  }

  let dateTicksSvg = '';
  const xCount = Math.min(5, data.length);
  for (let k = 0; k < xCount; k++) {
    const idx = Math.min(Math.round((k / Math.max(xCount - 1, 1)) * (data.length - 1)), data.length - 1);
    const d = data[idx];
    const posX = getX(idx);
    const dateStr = d.date.substring(2); // '26-03-13'
    dateTicksSvg += `
      <line x1="${posX.toFixed(1)}" y1="${padT + chartH}" x2="${posX.toFixed(1)}" y2="${padT + chartH + 4}" stroke="rgba(255,255,255,0.15)" stroke-width="1" />
      <text x="${posX.toFixed(1)}" y="${(padT + chartH + 18).toFixed(1)}" fill="#8e8e93" font-size="10" font-weight="500" text-anchor="${k === 0 ? 'start' : k === xCount - 1 ? 'end' : 'middle'}">${escapeHtml(dateStr)}</text>
    `;
  }

  const path3M = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${getX(i).toFixed(1)} ${getY(d.y3m).toFixed(1)}`).join(' ');
  const path5Y = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${getX(i).toFixed(1)} ${getY(d.y5y).toFixed(1)}`).join(' ');
  const path10Y = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${getX(i).toFixed(1)} ${getY(d.y10y).toFixed(1)}`).join(' ');

  container.innerHTML = `
    <svg id="yieldChartSvg" viewBox="0 0 ${width} ${height}" width="100%" height="100%">
      <!-- 그리드 & Y 라벨 -->
      ${gridSvg}
      <!-- X축 날짜 틱 -->
      ${dateTicksSvg}

      <!-- 3M 국채금리 (단기: 하늘색, 슬림 1.5px) -->
      <path d="${path3M}" fill="none" stroke="#38bdf8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />

      <!-- 5Y 국채금리 (중기: 황색, 슬림 1.5px) -->
      <path d="${path5Y}" fill="none" stroke="#f59e0b" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />

      <!-- 10Y 국채금리 (장기: 깔끔한 에메랄드 그린, 슬림 1.5px, 형광 필터 제거) -->
      <path d="${path10Y}" fill="none" stroke="#10b981" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />

      <!-- 크로스헤어 그룹 -->
      <g id="yieldCrossGroup" style="display: none;">
        <line id="yieldCrossLine" x1="0" y1="${padT}" x2="0" y2="${padT + chartH}" stroke="rgba(255,255,255,0.25)" stroke-width="1" stroke-dasharray="3,3" />
        <circle id="yieldDot3M" r="3.5" fill="#38bdf8" stroke="#181818" stroke-width="1.5" />
        <circle id="yieldDot5Y" r="3.5" fill="#f59e0b" stroke="#181818" stroke-width="1.5" />
        <circle id="yieldDot10Y" r="3.5" fill="#10b981" stroke="#181818" stroke-width="1.5" />
      </g>

      <!-- 마우스 감지 투명 오버레이 -->
      <rect id="yieldMouseOverlay" x="${padL}" y="${padT}" width="${chartW}" height="${chartH}" fill="transparent" style="cursor: crosshair;" />
    </svg>
    <div class="chart-tooltip-floating" id="yieldFloatingTooltip" style="display: none;"></div>
  `;

  const overlay = container.querySelector("#yieldMouseOverlay");
  const crossGroup = container.querySelector("#yieldCrossGroup");
  const crossLine = container.querySelector("#yieldCrossLine");
  const dot3M = container.querySelector("#yieldDot3M");
  const dot5Y = container.querySelector("#yieldDot5Y");
  const dot10Y = container.querySelector("#yieldDot10Y");
  const tooltip = container.querySelector("#yieldFloatingTooltip");

  if (overlay) {
    overlay.onmousemove = (e) => {
      const rect = overlay.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const ratio = Math.min(Math.max(mouseX / rect.width, 0), 1);
      const idx = Math.min(Math.round(ratio * (data.length - 1)), data.length - 1);
      const d = data[idx];
      if (!d) return;

      const px = getX(idx);
      const py3M = getY(d.y3m);
      const py5Y = getY(d.y5y);
      const py10Y = getY(d.y10y);

      crossGroup.style.display = "block";
      crossLine.setAttribute("x1", px);
      crossLine.setAttribute("x2", px);
      dot3M.setAttribute("cx", px);
      dot3M.setAttribute("cy", py3M);
      dot5Y.setAttribute("cx", px);
      dot5Y.setAttribute("cy", py5Y);
      dot10Y.setAttribute("cx", px);
      dot10Y.setAttribute("cy", py10Y);

      if (legY3M) legY3M.innerText = `${d.y3m.toFixed(2)}%`;
      if (legY5Y) legY5Y.innerText = `${d.y5y.toFixed(2)}%`;
      if (legY10Y) legY10Y.innerText = `${d.y10y.toFixed(2)}%`;

      if (tooltip) {
        tooltip.style.display = "flex";
        tooltip.innerHTML = `
          <span class="date-tag">${escapeHtml(d.date)}</span>
          <span class="val-tag" style="color:#38bdf8;">3M: ${d.y3m.toFixed(2)}%</span>
          <span class="val-tag" style="color:#f59e0b;">5Y: ${d.y5y.toFixed(2)}%</span>
          <span class="val-tag" style="color:#10b981;">10Y: ${d.y10y.toFixed(2)}%</span>
        `;
        const containerRect = container.getBoundingClientRect();
        let leftPos = px - 70;
        leftPos = Math.max(10, Math.min(leftPos, containerRect.width - 240));
        tooltip.style.left = `${leftPos}px`;
      }
    };

    overlay.onmouseleave = () => {
      crossGroup.style.display = "none";
      if (tooltip) tooltip.style.display = "none";
      if (legY3M && latest.y3m) legY3M.innerText = `${latest.y3m.toFixed(2)}%`;
      if (legY5Y && latest.y5y) legY5Y.innerText = `${latest.y5y.toFixed(2)}%`;
      if (legY10Y && latest.y10y) legY10Y.innerText = `${latest.y10y.toFixed(2)}%`;
    };
  }
}

function renderSpreadTimeSeriesChart(period = '6M') {
  const container = document.getElementById("spreadTimeSeriesContainer");
  if (!container || !MACRO_DATA) return;

  ["legendSpreadVal"].forEach(id => { const el = document.getElementById(id); if (el) el.innerText = "-"; });
  const data = getFilteredTreasuryData(period);
  if (!data.length) {
    container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#888;font-size:12px;">스프레드 시계열 데이터가 없습니다.</div>`;
    return;
  }

  const latest = data[data.length - 1];
  const legSpread = document.getElementById("legendSpreadVal");
  if (legSpread && typeof latest.spread === 'number') {
    const s = latest.spread;
    legSpread.innerText = (s >= 0 ? '+' : '') + s.toFixed(2) + '%p';
    legSpread.className = s >= 0 ? 'text-green' : 'text-red';
  }

  // 컨테이너 실제 픽셀 크기 측정 (비정상 가로 늘어남/왜곡 방지)
  const width = Math.max(container.clientWidth || 560, 320);
  const height = Math.max(container.clientHeight || 248, 180);

  const padL = 50, padR = 20, padT = 20, padB = 28;
  const chartW = width - padL - padR;
  const chartH = height - padT - padB;

  const spreads = data.map(d => d.spread).filter(v => typeof v === 'number' && !isNaN(v));
  const minSp = Math.min(...spreads);
  const maxSp = Math.max(...spreads);
  const minY = Math.floor((Math.min(minSp, -0.05) - 0.2) * 2) / 2;
  const maxY = Math.ceil((Math.max(maxSp, 0.2) + 0.2) * 2) / 2;
  const rangeY = Math.max(maxY - minY, 0.6);

  const getX = (i) => padL + (i / Math.max(data.length - 1, 1)) * chartW;
  const getY = (val) => padT + chartH - ((val - minY) / rangeY) * chartH;
  const zeroY = getY(0.0);

  const steps = 4;
  let gridSvg = '';
  for (let s = 0; s <= steps; s++) {
    const tickVal = minY + (rangeY * s) / steps;
    const tickY = getY(tickVal);
    gridSvg += `
      <line x1="${padL}" y1="${tickY.toFixed(1)}" x2="${padL + chartW}" y2="${tickY.toFixed(1)}" stroke="rgba(255,255,255,0.06)" stroke-width="1" ${s > 0 && s < steps ? 'stroke-dasharray="3,3"' : ''} />
      <text x="${padL - 8}" y="${(tickY + 3.5).toFixed(1)}" fill="#8e8e93" font-size="10" font-weight="500" text-anchor="end">${(tickVal >= 0 ? '+' : '') + tickVal.toFixed(1)}%p</text>
    `;
  }

  let dateTicksSvg = '';
  const xCount = Math.min(5, data.length);
  for (let k = 0; k < xCount; k++) {
    const idx = Math.min(Math.round((k / Math.max(xCount - 1, 1)) * (data.length - 1)), data.length - 1);
    const d = data[idx];
    const posX = getX(idx);
    const dateStr = d.date.substring(2);
    dateTicksSvg += `
      <line x1="${posX.toFixed(1)}" y1="${padT + chartH}" x2="${posX.toFixed(1)}" y2="${padT + chartH + 4}" stroke="rgba(255,255,255,0.15)" stroke-width="1" />
      <text x="${posX.toFixed(1)}" y="${(padT + chartH + 18).toFixed(1)}" fill="#8e8e93" font-size="10" font-weight="500" text-anchor="${k === 0 ? 'start' : k === xCount - 1 ? 'end' : 'middle'}">${escapeHtml(dateStr)}</text>
    `;
  }

  const pathSpread = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${getX(i).toFixed(1)} ${getY(d.spread).toFixed(1)}`).join(' ');
  const lastX = getX(data.length - 1).toFixed(1);
  const firstX = getX(0).toFixed(1);
  const areaSpread = `${pathSpread} L ${lastX} ${zeroY.toFixed(1)} L ${firstX} ${zeroY.toFixed(1)} Z`;

  container.innerHTML = `
    <svg id="spreadChartSvg" viewBox="0 0 ${width} ${height}" width="100%" height="100%">
      <defs>
        <linearGradient id="spreadAreaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#10b981" stop-opacity="0.12"/>
          <stop offset="100%" stop-color="#10b981" stop-opacity="0.00"/>
        </linearGradient>
      </defs>
      <!-- 그리드 & Y 라벨 -->
      ${gridSvg}
      <!-- X축 날짜 틱 -->
      ${dateTicksSvg}

      <!-- 0.00%p 침체 역전 기준선 (빨간색 얇은 점선) -->
      <line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${padL + chartW}" y2="${zeroY.toFixed(1)}" stroke="#ef4444" stroke-width="1" stroke-dasharray="4,4" opacity="0.85" />
      <text x="${padL + chartW - 4}" y="${(zeroY - 5).toFixed(1)}" fill="#ef4444" font-size="10" font-weight="600" text-anchor="end">0.00%p 침체 역전선</text>

      <!-- 스프레드 영역 채우기 (은은한 그라데이션) -->
      <path d="${areaSpread}" fill="url(#spreadAreaGrad)" />

      <!-- 스프레드 본체 라인 (슬림 1.5px, 에메랄드 그린, 형광 필터 제거) -->
      <path d="${pathSpread}" fill="none" stroke="#10b981" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />

      <!-- 크로스헤어 그룹 -->
      <g id="spreadCrossGroup" style="display: none;">
        <line id="spreadCrossLine" x1="0" y1="${padT}" x2="0" y2="${padT + chartH}" stroke="rgba(255,255,255,0.25)" stroke-width="1" stroke-dasharray="3,3" />
        <circle id="spreadCrossDot" r="3.5" fill="#10b981" stroke="#181818" stroke-width="1.5" />
      </g>

      <!-- 마우스 감지 투명 오버레이 -->
      <rect id="spreadMouseOverlay" x="${padL}" y="${padT}" width="${chartW}" height="${chartH}" fill="transparent" style="cursor: crosshair;" />
    </svg>
    <div class="chart-tooltip-floating" id="spreadFloatingTooltip" style="display: none;"></div>
  `;

  const overlay = container.querySelector("#spreadMouseOverlay");
  const crossGroup = container.querySelector("#spreadCrossGroup");
  const crossLine = container.querySelector("#spreadCrossLine");
  const crossDot = container.querySelector("#spreadCrossDot");
  const tooltip = container.querySelector("#spreadFloatingTooltip");

  if (overlay) {
    overlay.onmousemove = (e) => {
      const rect = overlay.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const ratio = Math.min(Math.max(mouseX / rect.width, 0), 1);
      const idx = Math.min(Math.round(ratio * (data.length - 1)), data.length - 1);
      const d = data[idx];
      if (!d) return;

      const px = getX(idx);
      const py = getY(d.spread);

      crossGroup.style.display = "block";
      crossLine.setAttribute("x1", px);
      crossLine.setAttribute("x2", px);
      crossDot.setAttribute("cx", px);
      crossDot.setAttribute("cy", py);
      crossDot.setAttribute("fill", d.spread >= 0 ? "#10b981" : "#ef4444");

      const sign = d.spread >= 0 ? '+' : '';
      const spreadStr = `${sign}${d.spread.toFixed(2)}%p`;
      if (legSpread) {
        legSpread.innerText = spreadStr;
        legSpread.className = d.spread >= 0 ? "text-green" : "text-red";
      }

      if (tooltip) {
        tooltip.style.display = "flex";
        const statusText = d.spread < 0 
          ? '<span style="color:#ef4444;margin-left:6px;font-weight:700;">(역전 경고)</span>' 
          : '<span style="color:#10b981;margin-left:6px;font-weight:700;">(정상 우상향)</span>';
        tooltip.innerHTML = `
          <span class="date-tag">${escapeHtml(d.date)}</span>
          <span class="val-tag" style="color:${d.spread >= 0 ? '#10b981' : '#ef4444'};">스프레드: ${spreadStr}</span>
          ${statusText}
        `;
        const containerRect = container.getBoundingClientRect();
        let leftPos = px - 80;
        leftPos = Math.max(10, Math.min(leftPos, containerRect.width - 250));
        tooltip.style.left = `${leftPos}px`;
      }
    };

    overlay.onmouseleave = () => {
      crossGroup.style.display = "none";
      if (tooltip) tooltip.style.display = "none";
      if (legSpread && typeof latest.spread === 'number') {
        const s = latest.spread;
        legSpread.innerText = (s >= 0 ? '+' : '') + s.toFixed(2) + '%p';
        legSpread.className = s >= 0 ? 'text-green' : 'text-red';
      }
    };
  }
}

function renderMacroMarketProxies() {
  const container = document.getElementById("macroMarketProxyGrid");
  if (!container || !MACRO_DATA) return;

  const treasury = MACRO_DATA.treasury || {};
  const cm = MACRO_DATA.commoditiesAndFx || {};

  const items = [
    {
      label: "미국 10년물 국채",
      val: Number.isFinite(treasury.yield10Y?.val) ? `${treasury.yield10Y.val.toFixed(2)}%` : "확인 불가",
      chg: Number.isFinite(treasury.yield10Y?.val) ? treasury.yield10Y.change : null,
      desc: "글로벌 자산 가격 할인율(무위험 수익률 척도)"
    },
    {
      label: "미국 3개월물 T-Bill",
      val: Number.isFinite(treasury.yield13W?.val) ? `${treasury.yield13W.val.toFixed(2)}%` : "확인 불가",
      chg: Number.isFinite(treasury.yield13W?.val) ? treasury.yield13W.change : null,
      desc: "단기 기준금리 및 현금성 자산 벤치마크"
    },
    {
      label: "미국 5년물 국채",
      val: Number.isFinite(treasury.yield5Y?.val) ? `${treasury.yield5Y.val.toFixed(2)}%` : "확인 불가",
      chg: Number.isFinite(treasury.yield5Y?.val) ? treasury.yield5Y.change : null,
      desc: "중기 경제 성장 및 인플레이션 기대치"
    },
    {
      label: "달러 인덱스 (DXY)",
      val: Number.isFinite(cm.dxy?.val) ? `${cm.dxy.val.toFixed(2)}` : "확인 불가",
      chg: Number.isFinite(cm.dxy?.val) ? cm.dxy.change : null,
      desc: "주요 6개 통화 대비 달러화 가치 (글로벌 유동성)"
    },
    {
      label: "WTI 국제유가",
      val: Number.isFinite(cm.wtiOil?.val) ? `$${cm.wtiOil.val.toFixed(2)}` : "확인 불가",
      chg: Number.isFinite(cm.wtiOil?.val) ? cm.wtiOil.change : null,
      desc: "원유 배럴당 가격 (헤드라인 물가 직결)"
    },
    {
      label: "국제 금 시세",
      val: Number.isFinite(cm.gold?.val) ? `$${cm.gold.val.toLocaleString()}` : "확인 불가",
      chg: Number.isFinite(cm.gold?.val) ? cm.gold.change : null,
      desc: "대표 안전자산 및 통화가치 하락 헷지 수단"
    }
  ];

  container.innerHTML = items.map(it => {
    const chgClass = it.chg > 0 ? "up" : (it.chg < 0 ? "down" : "");
    const chgSign = !Number.isFinite(it.chg) ? "확인 불가" : it.chg > 0 ? `+${it.chg}%` : (it.chg < 0 ? `${it.chg}%` : "0.0%");
    return `
      <div class="proxy-card">
        <span class="proxy-label">${it.label}</span>
        <div class="proxy-value-row">
          <span class="proxy-val">${it.val}</span>
          <span class="proxy-chg ${chgClass}">${chgSign}</span>
        </div>
        <span class="proxy-desc">${it.desc}</span>
      </div>
    `;
  }).join("");
}

function renderMacroCalendar() {
  const container = document.getElementById("macroCalendarGrid");
  if (!container || !MACRO_DATA) return;

  const calendar = MACRO_DATA.calendar || [];
  
  // 카운트 배지 갱신
  const countAll = calendar.length;
  const countFed = calendar.filter(c => c.category === "FED").length;
  const countInf = calendar.filter(c => c.category === "INFLATION").length;
  const countLab = calendar.filter(c => c.category === "LABOR" || c.category === "CONSUMER").length;

  const elAll = document.getElementById("macroCalCountAll");
  const elFed = document.getElementById("macroCalCountFed");
  const elInf = document.getElementById("macroCalCountInf");
  const elLab = document.getElementById("macroCalCountLab");

  if (elAll) elAll.innerText = countAll;
  if (elFed) elFed.innerText = countFed;
  if (elInf) elInf.innerText = countInf;
  if (elLab) elLab.innerText = countLab;

  // 필터 적용
  const filter = state.macroCalFilter || "ALL";
  const filtered = calendar.filter(item => {
    if (filter === "ALL") return true;
    if (filter === "FED") return item.category === "FED";
    if (filter === "INFLATION") return item.category === "INFLATION";
    if (filter === "LABOR") return item.category === "LABOR" || item.category === "CONSUMER";
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-subdued);">해당 카테고리의 일정이 없습니다.</div>`;
    return;
  }

  container.innerHTML = filtered.map(ev => {
    const impactClass = (ev.impact || "").toLowerCase();
    const catClass = (ev.category || "").toLowerCase();
    const isImminent = ev.daysDiff <= 7;
    const catLabels = {
      "FED": "연준 FOMC",
      "INFLATION": "물가 지표",
      "LABOR": "고용 지표",
      "CONSUMER": "소비 지표"
    };
    const catName = catLabels[ev.category] || ev.category;

    return `
      <div class="cal-event-card ${escapeHtml(impactClass)}">
        <div class="cal-card-top">
          <div class="cal-tag-group">
            <span class="cal-cat-badge ${escapeHtml(catClass)}">${escapeHtml(catName)}</span>
            <span class="cal-impact-badge ${escapeHtml(impactClass)}">${escapeHtml(ev.impact)} IMPACT</span>
          </div>
          <span class="cal-dday-pill ${isImminent ? 'imminent' : ''}">
            ${isImminent ? '<span class="pulse-dot"></span>' : ''}
            ${escapeHtml(ev.dDay)}
          </span>
        </div>
        <div class="cal-card-title">${escapeHtml(ev.name)}</div>
        <div class="cal-card-date">${ev.releaseDate ? `회의 개막: <strong>${escapeHtml(ev.date)}</strong> · 결과 발표: <strong>${escapeHtml(ev.releaseDate)}</strong>` : `발표일: <strong>${escapeHtml(ev.date)}</strong>`} (${escapeHtml(ev.daysDiff)}일 남음)</div>

        <!-- 3열 팩트 비교 박스 (이전치 vs 시장 예상치 vs 발표 결과) -->
        <div class="cal-compare-box">
          <div class="cal-compare-item">
            <span class="cal-compare-label">이전 발표치 (전월)</span>
            <span class="cal-compare-val">${escapeHtml(ev.previous || "확인 불가")}</span>
          </div>
          <div class="cal-compare-item">
            <span class="cal-compare-label">월가 시장 예상치</span>
            <span class="cal-compare-val" style="color: #c084fc;">${escapeHtml(ev.forecast || "확인 불가")}</span>
          </div>
          <div class="cal-compare-item">
            <span class="cal-compare-label">실제 발표치</span>
            <span class="cal-compare-val" style="color: #1ed760;">${escapeHtml(ev.actual || '발표 대기')}</span>
          </div>
        </div>

        <div class="cal-card-desc">${escapeHtml(ev.description)}</div>
      </div>
    `;
  }).join("");
}

function openMacroModal() {
  const modal = document.getElementById('macroModal');
  const body = document.getElementById('macroModalBody');
  if (!modal || !body) return;
  body.textContent = macroFreshness(MACRO_DATA) + '\n' + Object.entries(MACRO_DATA?.sources || {}).map(([key, source]) => `${key}: ${source.status || 'unknown'} · ${source.asOf || '관측일 없음'} · ${source.url || '출처 없음'}`).join('\n') + '\n거시경제 지표는 Macro 탭의 관측 데이터를 확인하세요. 시세가 없거나 오래된 경우 현재 시장 상황을 의미하지 않습니다.';
  modal.classList.add('active');
}

function closeMacroModal() {
  const modal = document.getElementById("macroModal");
  if (modal) modal.classList.remove("active", "show");
}

/* ==============================================================================
   📱 모바일 인터랙션 컨트롤러 (드로어 사이드바 & 하단 탭 바)
   ============================================================================== */
function initMobileInteractions() {
  const btnMenu = document.getElementById("btnMobileMenu");
  const btnClose = document.getElementById("btnSidebarClose");
  const backdrop = document.getElementById("sidebarBackdrop");
  const sidebar = document.getElementById("appSidebar");
  const btnMobileCsv = document.getElementById("btnMobileCsv");
  const btnMobileDrawerOpen = document.getElementById("btnMobileDrawerOpen");
  const bottomNav = document.getElementById("mobileBottomNav");

  function openSidebar() {
    if (sidebar) sidebar.classList.add("mobile-open");
    if (backdrop) backdrop.classList.add("active");
    document.body.style.overflow = "hidden";
  }

  function closeSidebar() {
    if (sidebar) sidebar.classList.remove("mobile-open");
    if (backdrop) backdrop.classList.remove("active");
    document.body.style.overflow = "";
  }

  if (btnMenu) btnMenu.addEventListener("click", openSidebar);
  if (btnClose) btnClose.addEventListener("click", closeSidebar);
  if (backdrop) backdrop.addEventListener("click", closeSidebar);
  if (btnMobileDrawerOpen) btnMobileDrawerOpen.addEventListener("click", openSidebar);

  if (btnMobileCsv) {
    btnMobileCsv.addEventListener("click", () => {
      const csvBtn = document.getElementById("btnExportCsv");
      if (csvBtn) csvBtn.click();
    });
  }

  // 모바일 하단 탭 바 클릭 시 해당 공시 모드로 즉시 전환
  if (bottomNav) {
    bottomNav.querySelectorAll(".mobile-nav-item[data-mode]").forEach(btn => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.mode;
        if (!mode) return;
        bottomNav.querySelectorAll(".mobile-nav-item").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        switchFilingMode(mode);
        closeSidebar();
      });
    });
  }
}

/* ==============================================================================
   🚨 1번 기능: 2026 Q3 SEC 13F 공시 시즌 실시간 D-Day 카운트다운 타이머
   ============================================================================== */
function nextFilingDeadline(now = Date.now()) {
  // Form 13F: 45 days after quarter-end, rolled to the next business day.
  // The only regular federal holiday these four due-date windows can meet is
  // Washington's Birthday (third Monday in February). Emergency SEC closures
  // are not predicted here. Source: SEC Form 13F FAQ, questions 25/26.
  const year = new Date(now).getUTCFullYear();
  for (let y = year - 1; y <= year + 1; y++) {
    for (let q = 1; q <= 4; q++) {
      const period = new Date(Date.UTC(y, q * 3, 0));
      const due = new Date(period.getTime() + 45 * 86400000);
      while (due.getUTCDay() === 0 || due.getUTCDay() === 6 ||
        (due.getUTCMonth() === 1 && due.getUTCDay() === 1 && due.getUTCDate() >= 15 && due.getUTCDate() <= 21)) {
        due.setUTCDate(due.getUTCDate() + 1);
      }
      // These dates are in February/May/August/November; U.S. DST is in effect
      // for the May/August due dates, standard time for February/November.
      const utcHour = [4, 7].includes(due.getUTCMonth()) ? 21 : 22;
      const deadlineTime = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate(), utcHour, 30);
      if (deadlineTime > now) return {
        quarter: `${y} Q${q}`,
        periodDate: period.toISOString().slice(0, 10),
        dueDate: due.toISOString().slice(0, 10),
        deadlineTime
      };
    }
  }
  return null;
}

function initFilingDdayCountdown() {
  const banner = document.getElementById('filingDdayBanner');
  const btnClose = document.getElementById('btnDdayClose');
  const badgeEl = document.getElementById('ddayBadge');
  const chipEl = document.getElementById('ddayTimerChip');
  const titleEl = document.getElementById('ddayHeadline');
  const detailEl = document.getElementById('ddayDeadline');
  if (!banner) return;

  const hideUntil = localStorage.getItem('alpha13f_dday_hide_until');
  if (hideUntil && Date.now() < Number(hideUntil)) {
    banner.style.display = 'none';
    return;
  }
  if (btnClose) btnClose.addEventListener('click', () => {
    banner.style.display = 'none';
    localStorage.setItem('alpha13f_dday_hide_until', Date.now() + 86400000);
  });

  function tick() {
    const now = Date.now();
    const upcoming = nextFilingDeadline(now);
    if (!upcoming) { banner.style.display = 'none'; return; }
    const diff = upcoming.deadlineTime - now;
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    if (titleEl) titleEl.innerText = `${upcoming.quarter} SEC 13F 제출 마감`;
    if (detailEl) detailEl.innerText = `${upcoming.periodDate} 보유분의 일반 제출 마감은 ${upcoming.dueDate} 오후 5:30 (미 동부시간)입니다.`;
    if (badgeEl) badgeEl.innerText = days ? `D-${days}` : 'D-DAY';
    if (chipEl) chipEl.innerText = `${days}일 ${String(hours).padStart(2, '0')}시간 ${String(mins).padStart(2, '0')}분 ${String(secs).padStart(2, '0')}초 남음`;
  }
  tick();
  setInterval(tick, 1000);
}

/* ==============================================================================
   🏆 3번 기능: 월가 큰손 집중 매수 (Smart Money Consensus) TOP 5 위젯
   ============================================================================== */
let CURRENT_CONSENSUS_TYPE = "HOLDERS";

function initConsensusTabs() {
  const wrap = document.getElementById("consensusToggleTabs");
  if (!wrap) return;
  wrap.querySelectorAll(".consensus-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      wrap.querySelectorAll(".consensus-tab-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderConsensusWidget(btn.dataset.type);
    });
  });
}

function renderConsensusWidget(forceType) {
  if (forceType) CURRENT_CONSENSUS_TYPE = forceType;
  const grid = document.getElementById("consensusCardsGrid");
  if (!grid || !RAW_HOLDINGS || RAW_HOLDINGS.length === 0) return;

  const stats = Object.create(null);

  RAW_HOLDINGS.forEach((item, rowIndex) => {
    if (!SEC_DISPLAY || !verifiedDisplayRow(item) || (item.schemaVersion !== 3 && isDerivativeOrOption(item.name, item.ticker, item.titleOfClass, item))) return;
    const baseTicker = getMappedTicker(item.name, item.ticker, item.cusip, item.shareType, item.putCall || item.optionType);
    if (!baseTicker || baseTicker === "UNKNOWN") return;

    const securityId = holdingIdentity({ ...item, securityId: null }, rowIndex);
    if (!stats[securityId]) {
      let displayName = item.name || baseTicker;
      if (baseTicker === "SPY") displayName = "SPDR S&P 500 ETF Trust";
      else if (baseTicker === "IVV") displayName = "iShares Core S&P 500 ETF";
      else if (baseTicker === "QQQ") displayName = "Invesco QQQ Trust";
      else if (baseTicker === "GOOGL") displayName = "Alphabet Inc. (Class A)";
      else if (baseTicker === "GOOG") displayName = "Alphabet Inc. (Class C)";
      else if (baseTicker === "META") displayName = "Meta Platforms Inc.";
      else if (baseTicker === "MSFT") displayName = "Microsoft Corp.";
      else if (baseTicker === "AMZN") displayName = "Amazon.com Inc.";
      else if (baseTicker === "AAPL") displayName = "Apple Inc.";
      else if (baseTicker === "NVDA") displayName = "NVIDIA Corp.";

      stats[securityId] = {
        ticker: baseTicker,
        securityId,
        name: displayName,
        sector: getMappedSector(baseTicker, item.sector),
        holders: new Set(),
        totalValue: 0
      };
    }

    const guruName = item.legalName;
    const val = Number(item.value) || 0;

    stats[securityId].holders.add(guruName);
    stats[securityId].totalValue += val;
  });

  const list = Object.values(stats);
  let sorted = [];

  if (CURRENT_CONSENSUS_TYPE === "HOLDERS") {
    // 🥇 최다 기관 합의 보유 순
    sorted = list
      .sort((a, b) => (b.holders.size - a.holders.size) || (b.totalValue - a.totalValue))
      .slice(0, 5);
  } else {
    // 🥈 최대 자금 집중(평가액) 순
    sorted = list
      .sort((a, b) => (b.totalValue - a.totalValue) || (b.holders.size - a.holders.size))
      .slice(0, 5);
  }

  if (sorted.length === 0) {
    grid.innerHTML = `<div style="grid-column: 1 / -1; padding: 24px; text-align: center; color: var(--text-subdued); font-size: 13px;">집계된 종목이 없습니다.</div>`;
    return;
  }

  grid.innerHTML = sorted.map((s, idx) => {
    const isHolders = CURRENT_CONSENSUS_TYPE === "HOLDERS";
    const holderCount = s.holders.size;
    const actionBadge = isHolders 
      ? `<span class="consensus-action-tag new">${holderCount}개사 보유</span>`
      : `<span class="consensus-action-tag add">부분집합 평가액</span>`;

    const realInfo = LIVE_PRICES[s.ticker];
    const currentQuote = quoteFields(s.ticker, realInfo);
    const priceText = priceLabel(currentQuote.curPrice);
    const chgVal = currentQuote.priceChangePct;
    const chgClass = chgVal > 0 ? "up" : (chgVal < 0 ? "down" : "");
    const chgText = Number.isFinite(chgVal) ? `${chgVal > 0 ? "+" : ""}${chgVal.toFixed(2)}%` : "";

    return `
      <div class="consensus-card" onclick="openConsensusStock(decodeURIComponent('${encodeURIComponent(s.securityId).replace(/'/g, '%27')}'))" title="클릭 시 ${escapeHtml(s.name)} 상세 분석 팝업을 엽니다">
        <div>
          <div class="consensus-rank-tag">TOP ${idx + 1}</div>
          <div class="consensus-card-header">
            <span class="consensus-ticker">${escapeHtml(s.ticker)}</span>
            ${actionBadge}
          </div>
          <div class="consensus-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</div>
        </div>
        <div>
          <div class="consensus-metric-row">
            <span class="consensus-metric-label">보유 기관수</span>
            <span class="consensus-metric-val" style="color: var(--spotify-green);">${holderCount}개 SEC 신고 법인</span>
          </div>
          <div class="consensus-metric-row">
            <span class="consensus-metric-label">합산 평가액</span>
            <span class="consensus-metric-val">${formatMoney(s.totalValue)}</span>
          </div>
          <div class="consensus-price-row">
            <span class="consensus-price">${escapeHtml(priceText)}</span>
            <span class="consensus-chg ${chgClass}">${chgText}</span>
          </div>
          <small class="consensus-quote-asof">${escapeHtml(currentQuote.quoteAsOf)}</small>
        </div>
      </div>
    `;
  }).join("");
}

function openConsensusStock(securityId) {
  const grand = GURU_DATABASE["__GRAND_TOTAL__"];
  if (grand && grand.holdings) {
    const found = grand.holdings.find(h => h.securityId === securityId);
    if (found) {
      openStockModal(found);
      return;
    }
  }
  // Do not synthesize prices, sectors or buy signals for missing holdings.
  return;
}

/* ==============================================================================
   🔗 2번 기능: 13F 종목 상세 모달 내 '최근 내부자 거래 (Form 4)' 교차 분석 연동
   ============================================================================== */
async function renderModalInsiderCross(item) {
  const requestId = ++insiderRequestId;
  const container = document.getElementById("modalInsiderContent");
  const convictionBadge = document.getElementById("modalConvictionBadge");
  if (!container) return;

  container.innerHTML = `<div style="padding: 16px; text-align: center; color: var(--text-subdued); font-size: 12px;">최근 경영진 내부자 거래(Form 4) 공시 대조 중...</div>`;
  if (convictionBadge) convictionBadge.style.display = "none";

  // Form 4 데이터가 메모리에 없으면 즉시 로드
  if (!FORM4_DATA || FORM4_DATA.length === 0) {
    try {
      const res = await fetch("latest_form4_insiders.json?v=" + Date.now());
      if (res.ok) {
        FORM4_DATA = await res.json();
      }
    } catch (e) {
      console.warn("Form 4 로드 실패:", e);
    }
  }

  if (requestId !== insiderRequestId) return;
  const ticker = (item.baseTicker || item.ticker || "").toUpperCase();
  const matched = (FORM4_DATA || []).filter(f => (f.ticker || "").toUpperCase() === ticker);

  if (!matched || matched.length === 0) {
    container.innerHTML = `
      <div class="insider-empty-msg">
        <p>최근 공시된 핵심 경영진 내부자 거래 내역이 없거나 Form 4 모니터링 대상 기업에 포함되지 않았습니다.</p>
        <span class="btn-goto-f4" onclick="switchToForm4WithTicker(decodeURIComponent('${encodeURIComponent(ticker).replace(/'/g, '%27')}'))">Form 4 전체 내부자 거래 대시보드 바로가기 ↗</span>
      </div>
    `;
    return;
  }

  // 장내 매수(Code P) 여부 판정
  const hasBuy = matched.some(f => insiderCode(f) === "P");
  const isGuruBuy = item.action === "NEW" || item.action === "ADD";

  if (hasBuy && isGuruBuy && convictionBadge) {
    convictionBadge.style.display = "inline-block";
    convictionBadge.innerText = "기관 증가·내부자 매수 공시 있음 (기간 상이 가능)";
    convictionBadge.title = "13F와 Form 4는 보고 기준일이 다를 수 있습니다. 동시 매수나 투자 성과를 의미하지 않습니다.";
  } else if (hasBuy && convictionBadge) {
    convictionBadge.style.display = "inline-block";
    convictionBadge.innerText = "💼 임원 장내 매수 (Code P) 포착";
  }

  // 최근 5건 거래 목록 표
  const recentTrades = [...matched].sort((a, b) => String(b.filingDate || "").localeCompare(String(a.filingDate || ""))).slice(0, 5);
  const rowsHtml = recentTrades.map(trade => {
    const isP = insiderCode(trade) === "P";
    const typeBadge = isP 
      ? `<span class="badge" style="background: rgba(30,215,96,0.18); color: #1ed760; font-size: 10px; font-weight: 800;">장내 매수 (P)</span>`
      : `<span class="badge" style="background: rgba(243,114,127,0.18); color: #f3727f; font-size: 10px; font-weight: 800;">${escapeHtml(insiderLabel(trade))}</span>`;
    
    const sharesDisplay = trade.shares ? Number(trade.shares).toLocaleString() + " 주" : "-";
    const priceDisplay = trade.price ? `$${Number(trade.price).toFixed(2)}` : "-";
    const totalValDisplay = trade.totalValue != null ? formatMoney(trade.totalValue) : (trade.shares && trade.price ? formatMoney(trade.shares * trade.price) : "-");

    return `
      <tr>
        <td style="white-space: nowrap; color: #9ca3af;">${escapeHtml(trade.filingDate || trade.transactionDate || "-")}</td>
        <td style="font-weight: 700; color: #ffffff;">${escapeHtml(trade.insiderName || "-")}</td>
        <td style="color: var(--text-subdued);">${escapeHtml(trade.officerTitle || trade.insiderRole || "경영진/임원")}</td>
        <td style="text-align: center;">${typeBadge}</td>
        <td style="text-align: right;">${sharesDisplay}</td>
        <td style="text-align: right;">${priceDisplay}</td>
        <td style="text-align: right; font-weight: 700; color: #ffffff;">${totalValDisplay}</td>
      </tr>
    `;
  }).join("");

  container.innerHTML = `
    <div class="insider-cross-table-wrap">
      <table class="insider-cross-table">
        <thead>
          <tr>
            <th>공시일자</th>
            <th>내부자 성명</th>
            <th>직책</th>
            <th style="text-align: center;">유형</th>
            <th style="text-align: right;">수량</th>
            <th style="text-align: right;">단가</th>
            <th style="text-align: right;">총 대금</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
    <div style="margin-top: 10px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
      <span style="font-size: 11px; color: var(--text-subdued);">최근 공시 총 ${matched.length}건 중 최신 5건 표시</span>
      <span class="btn-goto-f4" onclick="switchToForm4WithTicker(decodeURIComponent('${encodeURIComponent(ticker).replace(/'/g, '%27')}'))">이 종목의 Form 4 내부자 거래 전체 보기 ↗</span>
    </div>
  `;
}

function switchToForm4WithTicker(ticker) {
  const modal = document.getElementById("stockModal");
  if (modal) modal.classList.remove("show");
  
  switchFilingMode("FORM4");
  
  setTimeout(() => {
    const searchInput = document.getElementById("f4SearchInput");
    if (searchInput) {
      searchInput.value = ticker;
      searchInput.dispatchEvent(new Event("input"));
    }
  }, 150);
}





// Numeric views are restricted to the integrity-checked partial generation.
function verifiedDisplayRow(row) {
  return !!SEC_DISPLAY && SEC_DISPLAY_ROWS.has(row) &&
    (row.schemaVersion !== 3 || SECDisplayLoader.isReportedEquity(row, SEC_DISPLAY.classificationPolicy || [])) &&
    typeof row.legalName === 'string' && row.legalName.length > 0 && /^\d{10}$/.test(row.cik) &&
    Number.isSafeInteger(row.value) && row.value >= 0 && Number.isSafeInteger(row.shares) && row.shares >= 0 &&
    ['SH', 'PRN'].includes(row.shareType) && ['', 'PUT', 'CALL'].includes(row.putCall) &&
    typeof row.sourceRowId === 'string' && /^[a-f0-9]{64}$/.test(row.tableSha256) &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.period) && /^\d{4}-\d{2}-\d{2}$/.test(row.filingDate) &&
    /^\d{10}-\d{2}-\d{6}$/.test(row.accession) && /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\//.test(row.sourceUrl);
}
function showUnavailableHoldings() {
  RAW_HOLDINGS = [];
  GURU_DATABASE = { __GRAND_TOTAL__: { name: '검증된 공시 수치 없음', fund: '부분집합 사용 불가',
    desc: '검증 실패 또는 확인된 행이 없습니다. 기존 미검증 자료를 대신 표시하지 않습니다.',
    aum: '확인된 수치 없음', rawAum: null, holdings: [], quarter: '확인 불가' } };
  for (const [id, text] of Object.entries({currentGuruName:'검증된 공시 수치 없음',currentFundName:'부분집합 사용 불가',currentQuarter:'보유 기준일 확인 불가',currentGuruDesc:'검증된 자료가 없어 수치를 표시하지 않습니다.'})) { const el = document.getElementById(id); if (el) el.textContent = text; }
  for (const id of ['metricTotalAum', 'metricTotalHoldings', 'metricTopBuy', 'metricTopHolding', 'metricDiscountPick']) {
    const el = document.getElementById(id); if (el) el.textContent = '확인 불가';
  }
  for (const id of ['consensusCardsGrid', 'tableBody', 'treemapContainer', 'sectorStackedBar', 'sectorLegend', 'partialSourceList']) {
    const el = document.getElementById(id); if (el) el.textContent = '';
  }
  ACTIVE_STOCK_ITEM = null;
  const modal = document.getElementById('stockModal'); if (modal?.classList) modal.classList.remove('show');
  renderGuruSidebar();
}
function renderPartialCoverage(error) {
  const status = document.getElementById('partialDisplayStatus');
  const list = document.getElementById('partialCoverageList');
  if (list) list.replaceChildren();
  if (!SEC_DISPLAY) {
    if (status) status.textContent = '공시 부분집합 사용 불가. 검증되지 않은 기존 자료는 표시하지 않습니다.';
    return;
  }
  if (status) status.textContent = `43/50 추적명 확인 · 42개 SEC 신고 법인 · 7개 검증 중. ${SEC_DISPLAY.freshness.label} · 불러온 UTC ${SEC_DISPLAY.freshness.loadedAt || "미확인"} · 최초 원천 확인 UTC ${SEC_DISPLAY.freshness.acquisitionStartedAt || SEC_DISPLAY.manifest?.acquisitionStartedAt || "미확인"} · 마지막 확인 UTC ${SEC_DISPLAY.freshness.lastCheckedAt}. 전체 커버리지 및 현재 실시간 포트폴리오가 아닙니다. 숫자 합계는 검증된 비파생 주식 부분집합입니다. 매매 방향 UNKNOWN · 추정 매입가 및 가격 비교 미제공.`;
  for (const item of SEC_DISPLAY.coverage.labels) {
    const li = document.createElement('li');
    li.textContent = `${item.label} (원래 추적명) · ${item.status === 'available' ? `확인됨 · SEC 신고 법인 ${item.legalName} · CIK ${item.cik}` : `검증 중 · ${item.reason || '원천 무결성 확인 대기'} · 보유 수치 없음`}`;
    if (list) list.appendChild(li);
  }
}
function renderSelectedSources(guru) {
  const container = document.getElementById('partialSourceList');
  if (!container) return;
  container.replaceChildren();
  if (!SEC_DISPLAY) return;
  const sources = guru.sources || SEC_DISPLAY.sources;
  for (const source of sources || []) {
    const line = document.createElement('p');
    line.textContent = `${source.legalName || ''} · 보유 기준일 ${source.period} · 공시/수정 공시일 ${source.filingDate} · `;
    const link = document.createElement('a');
    link.textContent = source.accession;
    link.href = safeSecUrl(source.sourceUrl);
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    line.appendChild(link); container.appendChild(line);
  }
}
function buildPartialCsv(guru) {
  if (!SEC_DISPLAY) throw new Error('Verified partial display unavailable');
  const rows = [
    ['범위', '확인된 공시 부분집합: 43/50 추적명, 42 SEC 신고 법인, 7 검증 중'],
    ['주의', '전체 커버리지 또는 현재 실시간 포트폴리오 아님; 매입가/가격비교 미검증'],
    ['불러온 UTC', SEC_DISPLAY.freshness.loadedAt || '미확인'],
    ['최초 원천 확인 UTC', SEC_DISPLAY.freshness.acquisitionStartedAt || SEC_DISPLAY.manifest?.acquisitionStartedAt || '미확인'],
    ['마지막 확인 UTC', SEC_DISPLAY.freshness.lastCheckedAt, SEC_DISPLAY.freshness.label],
    ['법인/부분집합', guru.name],
    ['종목', '티커', 'CUSIP', '주식 유형', '옵션', '보유 신고 법인 수', '매매 방향', '주식수', '평가금액 USD', '부분집합 비중 %', '보유 기준일 시작', '보유 기준일 끝', '매입가', '가격 비교']
  ];
  for (const h of guru.holdings || []) {
    if (!Number.isSafeInteger(h.value) || !Number.isSafeInteger(h.rawShares) || !h.shareType || !h.cusip) continue;
    rows.push([h.name, h.ticker, h.cusip, h.shareType, h.putCall || '', h.holders || 1, 'UNKNOWN', h.rawShares, h.value, h.weight,
      h.periodRange?.[0] || '', h.periodRange?.[1] || '', '미검증', '미검증']);
  }
  rows.push(['출처', '법인', '보유 기준일', '공시/수정 공시일', 'SEC accession', 'SEC 원문']);
  for (const source of guru.sources || SEC_DISPLAY.sources || []) rows.push(['SEC', source.legalName || guru.name, source.period, source.filingDate, source.accession, source.sourceUrl]);
  return '\uFEFF' + rows.map(row => row.map(cell => {
    const text = String(cell ?? '');
    return '"' + (/^[=+@\-]/.test(text) ? "'" : '') + text.replace(/"/g, '""') + '"';
  }).join(',')).join('\n');
}
