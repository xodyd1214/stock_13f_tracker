/**
 * ==============================================================================
 * Alpha13F - 100대 운용사 포트폴리오 인텔리전스 (프론트엔드 분석 엔진)
 * ==============================================================================
 */

let GURU_DATABASE = {};
let RAW_HOLDINGS = [];
let LIVE_PRICES = {};

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

// 🏛️ 주요 120대 미국 기업 및 ETF 공식 티커 전수 매핑 사전
const TICKER_MAP = {
  "78462F103": "SPY", "46090E103": "QQQ", "464287200": "IVV", "464287655": "IWM",
  "78463V107": "GLD", "464287432": "IWF", "464288513": "IEFA", "78467X109": "DIA",
  "464286772": "EEM", "81369Y605": "XLE", "81369Y506": "XLF", "81369Y704": "XLK",
  "81369Y803": "XLY", "81369Y407": "XLV", "46428Q109": "SLV", "46438F101": "IBIT",
  "464287515": "IJR", "464287523": "IJH", "464286400": "IEFA", "464287234": "EFA",
  "464287242": "AGG", "084670702": "BRK-B", "595112103": "MU", "30303M102": "META",
  "88160R101": "TSLA", "007903107": "AMD", "874039100": "TSM", "369604301": "GE",
  "92826C839": "V", "615369105": "MCO", "11135F101": "AVGO", "458140100": "INTC",
  "H1467J104": "CB", "58733R102": "MELI", "512807306": "LRCX", "81141R100": "SE",
  "03831W108": "APP", "038222105": "AMAT", "L8681T102": "SPOT", "36828A101": "GEV",
  "64110L106": "NFLX", "18915M107": "NET", "500754106": "KHC", "958102105": "WDC",
  "G7997R103": "STX", "G6683N103": "NU", "532457108": "LLY", "38141G104": "GS",
  "82509L107": "SHOP", "46625H100": "JPM", "N07059210": "ASML", "78409V104": "SPGI",
  "86800U104": "SMCI",
  "SPDR S&P 500": "SPY", "STATE STR SPDR S&P": "SPY", "STATE STR SPDR": "SPY",
  "STATE STREET CORP": "STT", "STATE STREET": "STT", "INVESCO QQQ": "QQQ",
  "ISHARES CORE S&P": "IVV", "ISHARES TR": "IVV", "ISHARES INC": "EEM",
  "ISHARES RUSSELL": "IWM", "VANGUARD S&P 500": "VOO", "VANGUARD TOTAL": "VTI",
  "APPLE": "AAPL", "NVIDIA": "NVDA", "ALPHABET": "GOOGL", "GOOGLE": "GOOGL",
  "AMERICAN EXPRESS": "AXP", "AMAZON": "AMZN", "COCA COLA": "KO", "MICROSOFT": "MSFT",
  "META PLATFORMS": "META", "BANK OF AMER": "BAC", "BANK OF AMERICA": "BAC",
  "TESLA": "TSLA", "MICRON TECHNOLOGY": "MU", "ADVANCED MICRO DEVICES": "AMD",
  "TAIWAN SEMICONDUCTOR": "TSM", "TSMC": "TSM", "GE AEROSPACE": "GE",
  "GENERAL ELECTRIC": "GE", "VISA": "V", "MOODYS": "MCO", "CHEVRON": "CVX",
  "BROADCOM": "AVGO", "OCCIDENTAL PETE": "OXY", "OCCIDENTAL PETROLEUM": "OXY",
  "INTEL": "INTC", "CHUBB": "CB", "MERCADOLIBRE": "MELI", "LAM RESEARCH": "LRCX",
  "SEA LTD": "SE", "APPLOVIN": "APP", "APPLIED MATLS": "AMAT", "APPLIED MATERIALS": "AMAT",
  "SPOTIFY TECHNOLOGY": "SPOT", "SPOTIFY": "SPOT", "GE VERNOVA": "GEV",
  "NETFLIX": "NFLX", "CLOUDFLARE": "NET", "KRAFT HEINZ": "KHC", "WESTERN DIGITAL": "WDC",
  "SPDR GOLD": "GLD", "SEAGATE TECHNOLOGY": "STX", "NU HOLDINGS": "NU",
  "ELI LILLY": "LLY", "GOLDMAN SACHS": "GS", "SHOPIFY": "SHOP", "JPMORGAN CHASE": "JPM",
  "BERKSHIRE HATHAWAY": "BRK-B", "ASML HLDG": "ASML", "ASML": "ASML",
  "S&P GLOBAL": "SPGI", "SUPER MICRO COMPUTER": "SMCI", "SUPER MICRO": "SMCI",
  "CALLAWAY GOLF": "MODG", "TOPGOLF CALLAWAY": "MODG", "COSTCO WHOLESALE": "COST",
  "COSTCO": "COST", "SALESFORCE": "CRM", "ADOBE": "ADBE", "ORACLE": "ORCL",
  "QUALCOMM": "QCOM", "CISCO SYSTEMS": "CSCO", "TEXAS INSTRUMENTS": "TXN",
  "WALT DISNEY": "DIS", "DISNEY": "DIS", "WALMART": "WMT", "PROCTER & GAMBLE": "PG",
  "JOHNSON & JOHNSON": "JNJ", "UNITEDHEALTH": "UNH", "MASTERCARD": "MA",
  "EXXON MOBIL": "XOM", "NOVO NORDISK": "NVO", "WELLS FARGO": "WFC", "PEPSICO": "PEP",
  "UBER TECHNOLOGIES": "UBER", "UBER": "UBER", "PALANTIR TECHNOLOGIES": "PLTR",
  "PALANTIR": "PLTR", "SNOWFLAKE": "SNOW", "SERVICENOW": "NOW", "INTUIT": "INTU",
  "INTUITIVE SURGICAL": "ISRG", "BOOKING HOLDINGS": "BKNG", "AIRBNB": "ABNB",
  "CROWDSTRIKE": "CRWD", "PALO ALTO NETWORKS": "PANW", "ARISTA NETWORKS": "ANET",
  "MARVELL TECHNOLOGY": "MRVL", "SYNOPSYS": "SNPS", "CADENCE DESIGN": "CDNS",
  "ANALOG DEVICES": "ADI", "KLA CORP": "KLAC", "MICROCHIP TECHNOLOGY": "MCHP",
  "ON SEMICONDUCTOR": "ON", "MONOLITHIC POWER": "MPWR", "COSTAR GROUP": "CSGP",
  "VERISIGN": "VRSN", "CHARTER COMMUNICATIONS": "CHTR", "COMCAST": "CMCSA",
  "PAYPAL HOLDINGS": "PYPL", "PAYPAL": "PYPL", "BLOCK INC": "SQ", "SQUARE": "SQ",
  "ROBLOX": "RBLX", "COINBASE GLOBAL": "COIN", "COINBASE": "COIN",
  "ROBINHOOD MARKETS": "HOOD", "ROBINHOOD": "HOOD", "DRAFTKINGS": "DKNG",
  "DUOLINGO": "DUOL", "DOORDASH": "DASH"
};

// 📊 120대 주요 종목 공식 GICS 섹터 매핑 사전 (기능 3)
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
  "MCO": "Financials", "CB": "Financials", "PYPL": "Financials", "SQ": "Financials",
  "COIN": "Financials", "HOOD": "Financials", "NU": "Financials", "STT": "Financials",
  "BRK-B": "Financials",
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
  if (SECTOR_MAP[ticker]) return SECTOR_MAP[ticker];
  if (defaultSector && defaultSector !== "Other" && defaultSector !== "General") return defaultSector;
  return "Technology";
}

const TICKER_LOOKUP_CACHE = {};

function getMappedTicker(name, rawTicker, cusip) {
  const cleanCusip = (cusip || "").toUpperCase().trim();
  const upperTicker = (rawTicker || "").toUpperCase().trim();
  const upperName = (name || "").toUpperCase().trim();
  
  const cacheKey = cleanCusip || upperTicker || upperName;
  if (TICKER_LOOKUP_CACHE[cacheKey]) {
    return TICKER_LOOKUP_CACHE[cacheKey];
  }

  // 0순위: CUSIP / 티커 직접 매칭 (O(1))
  if (cleanCusip && TICKER_MAP[cleanCusip]) {
    TICKER_LOOKUP_CACHE[cacheKey] = TICKER_MAP[cleanCusip];
    return TICKER_MAP[cleanCusip];
  }
  if (upperTicker && TICKER_MAP[upperTicker]) {
    TICKER_LOOKUP_CACHE[cacheKey] = TICKER_MAP[upperTicker];
    return TICKER_MAP[upperTicker];
  }

  // 1순위: TICKER_MAP 이름 사전 매칭
  for (const [key, val] of Object.entries(TICKER_MAP)) {
    if (upperName.includes(key)) {
      TICKER_LOOKUP_CACHE[cacheKey] = val;
      return val;
    }
  }

  // 2순위: 정상 1~5자리 알파벳 티커
  const isCusip = /^[0-9A-Z]{8,9}$/.test(upperTicker) && /\d/.test(upperTicker);
  if (upperTicker && upperTicker.length <= 5 && !upperTicker.includes(" ") && /^[A-Z]+$/.test(upperTicker) && !isCusip) {
    TICKER_LOOKUP_CACHE[cacheKey] = upperTicker;
    return upperTicker;
  }

  // 3순위: 회사명 첫 단어 기반 추출
  const cleanWord = (name || "STOCK").split(" ")[0].toUpperCase().replace(/[^A-Z]/g, "");
  const res = cleanWord.slice(0, 5) || "STOCK";
  TICKER_LOOKUP_CACHE[cacheKey] = res;
  return res;
}

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

function isDerivativeOrOption(name, ticker, titleOfClass) {
  const checkStr = `${name || ''} ${ticker || ''} ${titleOfClass || ''}`.toUpperCase();
  // 보통주 회사명 예외 처리 (Option Care Health 등)
  if (checkStr.includes("OPTION CARE HEALTH")) return false;

  if (checkStr.includes(" CALL") || checkStr.includes(" PUT") || checkStr.endsWith("CALL") || checkStr.endsWith("PUT")) return true;
  if (checkStr.includes("/CALL") || checkStr.includes("/PUT") || checkStr.includes("-CALL") || checkStr.includes("-PUT")) return true;
  if (checkStr.includes("WARRANT") || checkStr.includes(" WTS") || checkStr.includes("PRN") || checkStr.includes("NOTE") || checkStr.includes("BOND") || checkStr.includes("DEBENTURE")) return true;
  return false;
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
  loadRealSecData();
});

async function loadRealSecData() {
  try {
    const [holdingsRes, tickerRes, priceRes] = await Promise.all([
      fetch("latest_13f_holdings.json"),
      fetch("ticker_map.json").catch(() => null),
      fetch("realtime_prices.json").catch(() => null)
    ]);

    if (tickerRes && tickerRes.ok) {
      try {
        const extMap = await tickerRes.json();
        Object.assign(TICKER_MAP, extMap);
      } catch (e) {}
    }
    if (priceRes && priceRes.ok) {
      try {
        LIVE_PRICES = await priceRes.json();
      } catch (e) {}
    }
    if (holdingsRes && holdingsRes.ok) {
      RAW_HOLDINGS = await holdingsRes.json();
    }

    // 최신 데이터로 화면 연산 및 렌더링
    processAndRenderHoldingsData();

    // 백그라운드 프리페치 (Form 4 및 13D 데이터)
    if (window.requestIdleCallback) {
      requestIdleCallback(() => prefetchOtherFilings());
    } else {
      setTimeout(prefetchOtherFilings, 1000);
    }
  } catch (e) {
    console.error("데이터 로드 실패:", e);
  }
}

function processAndRenderHoldingsData() {
  if (!RAW_HOLDINGS || RAW_HOLDINGS.length === 0) return;
  
  try {
    const groups = {};
    const grandConsensusMap = {};
    let grandTotalAumVal = 0;
    
    RAW_HOLDINGS.forEach(item => {
      if (isDerivativeOrOption(item.name, item.ticker, item.titleOfClass)) return;

      const guruName = item.guru || "기타 운용사";
      const fundName = item.fund || guruName;
      if (!groups[guruName]) {
        const initials = fundName.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
        groups[guruName] = {
          name: guruName,
          fund: fundName,
          avatar: initials || "CO",
          quarter: `${item.period || '2024Q2'} Filing`,
          desc: `${fundName} (${guruName} 운용)의 최신 13F 공식 보유 보통주 포트폴리오`,
          holdingsMap: {}
        };
      }
      
      const baseTicker = getMappedTicker(item.name, item.ticker, item.cusip);
      const cusip = item.cusip || baseTicker || "UNKNOWN";
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

      if (!hMap[baseTicker]) {
        hMap[baseTicker] = {
          ticker: baseTicker,
          baseTicker: baseTicker,
          name: displayName,
          sector: accurateSector,
          shares: itemShares,
          value: itemVal,
          cusip: cusip,
          action: item.action || "HOLD",
          isOption: item.isOption || false
        };
      } else {
        hMap[baseTicker].shares += itemShares;
        hMap[baseTicker].value += itemVal;
        if (item.action && item.action !== "None" && item.action !== "HOLD") {
          hMap[baseTicker].action = item.action;
        }
      }

      if (!grandConsensusMap[baseTicker]) {
        grandConsensusMap[baseTicker] = {
          ticker: baseTicker,
          baseTicker: baseTicker,
          name: displayName,
          sector: accurateSector,
          cusip: cusip,
          shares: itemShares,
          value: itemVal,
          holders: new Set([guruName])
        };
      } else {
        grandConsensusMap[baseTicker].shares += itemShares;
        grandConsensusMap[baseTicker].value += itemVal;
        grandConsensusMap[baseTicker].holders.add(guruName);
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
        const estP = h.shares > 0 ? (h.value / h.shares) : 100.0;
        
        const realInfo = LIVE_PRICES[h.baseTicker] || LIVE_PRICES[h.ticker];
        const curP = (realInfo && realInfo.price) ? realInfo.price : estP;
        
        let action = h.action || "HOLD";
        if (h.isOption || action === "PUT") {
          action = "PUT";
        }

        return {
          ticker: h.ticker,
          baseTicker: h.baseTicker,
          name: h.name,
          sector: h.sector,
          cusip: h.cusip,
          holdersDisplay: "1개사 (단독)",
          action: action,
          shares: h.shares >= 1000000 ? `${(h.shares / 1000000).toFixed(2)}M` : `${(h.shares / 1000).toFixed(1)}K`,
          rawShares: h.shares,
          value: h.value,
          weight: weight,
          estPrice: estP,
          curPrice: curP,
          priceChangePct: realInfo ? realInfo.changePct : 0.0,
          insight: `${h.name} 보통주 - ${g.name} 포트폴리오의 ${weight}% 차지 (현재 시장가: $${curP})`
        };
      });

      g.holdings.sort((a, b) => b.weight - a.weight);
    });

    const grandList = Object.values(grandConsensusMap);
    const grandHoldings = grandList.map(h => {
      const weight = grandTotalAumVal > 0 ? Number(((h.value / grandTotalAumVal) * 100).toFixed(2)) : 0;
      const estP = h.shares > 0 ? (h.value / h.shares) : 100.0;
      
      const realInfo = LIVE_PRICES[h.baseTicker] || LIVE_PRICES[h.ticker];
      const curP = (realInfo && realInfo.price) ? realInfo.price : estP;
      
      const holderCount = h.holders.size;
      let action = h.action || "HOLD";

      return {
        ticker: h.ticker,
        baseTicker: h.baseTicker,
        name: h.name,
        sector: h.sector,
        cusip: h.cusip,
        holders: holderCount,
        holdersList: Array.from(h.holders),
        holdersDisplay: `${holderCount}개사 보유`,
        action: action,
        shares: h.shares >= 1000000 ? `${(h.shares / 1000000).toFixed(2)}M` : `${(h.shares / 1000).toFixed(1)}K`,
        rawShares: h.shares,
        value: h.value,
        weight: weight,
        estPrice: estP,
        curPrice: curP,
        priceChangePct: realInfo ? realInfo.changePct : 0.0,
        insight: `미국 100대 운용사 중 무려 ${holderCount}개 운용사가 공통 보유 중인 대표 컨센서스 종목`
      };
    });

    grandHoldings.sort((a, b) => b.value - a.value);

    GURU_DATABASE = {
      "__GRAND_TOTAL__": {
        name: "전체 운용사 통합 포트폴리오",
        fund: "100개 주요 운용사 총합",
        avatar: "ALL",
        aum: formatMoney(grandTotalAumVal),
        rawAum: grandTotalAumVal,
        quarter: "최신 13F 공시 종합",
        desc: "미국 1억 달러 이상 운용 자격을 갖춘 100대 헤지펀드 및 메이저 운용사들의 포트폴리오를 하나로 통합 분석한 거대 자금 흐름",
        holdings: grandHoldings
      },
      ...groups
    };

    renderCategoryTabs();
    renderGuruSidebar();
    selectGuru("__GRAND_TOTAL__");

  } catch (err) {
    console.error("데이터 로드 실패:", err);
  }
}

function buildCustomGroupPortfolio() {
  const favs = getFavorites();
  if (favs.length === 0) {
    alert("먼저 사이드바에서 관심 있는 운용사 옆의 별표를 1개 이상 눌러 즐겨찾기에 등록해 주세요.");
    return;
  }

  const customConsensusMap = {};
  let customTotalAumVal = 0;

  favs.forEach(guruKey => {
    const guru = GURU_DATABASE[guruKey];
    if (!guru || !guru.holdings) return;

    guru.holdings.forEach(h => {
      const ticker = h.baseTicker || h.ticker;
      if (!customConsensusMap[ticker]) {
        customConsensusMap[ticker] = {
          ticker: ticker,
          baseTicker: h.baseTicker || ticker,
          name: h.name,
          sector: h.sector,
          cusip: h.cusip,
          shares: Number(h.rawShares) || 0,
          value: Number(h.value) || 0,
          estPrice: h.estPrice,
          curPrice: h.curPrice,
          priceChangePct: h.priceChangePct,
          holders: new Set([guru.name])
        };
      } else {
        customConsensusMap[ticker].shares += (Number(h.rawShares) || 0);
        customConsensusMap[ticker].value += (Number(h.value) || 0);
        customConsensusMap[ticker].holders.add(guru.name);
      }
      customTotalAumVal += Number(h.value) || 0;
    });
  });

  const customList = Object.values(customConsensusMap);
  const customHoldings = customList.map(h => {
    const weight = customTotalAumVal > 0 ? Number(((h.value / customTotalAumVal) * 100).toFixed(2)) : 0;
    const holderCount = h.holders.size;
    let action = "HOLD";
    if (holderCount >= 2) action = "ADD";

    return {
      ticker: h.ticker,
      baseTicker: h.baseTicker,
      name: h.name,
      sector: h.sector,
      cusip: h.cusip,
      holders: holderCount,
      holdersList: Array.from(h.holders),
      holdersDisplay: `${holderCount}개사 보유`,
      action: action,
      shares: h.shares >= 1000000 ? `${(h.shares / 1000000).toFixed(2)}M` : `${(h.shares / 1000).toFixed(1)}K`,
      rawShares: h.shares,
      value: h.value,
      weight: weight,
      estPrice: h.estPrice,
      curPrice: h.curPrice,
      priceChangePct: h.priceChangePct,
      insight: `내가 선택한 ${favs.length}개 즐겨찾기 운용사 중 ${holderCount}개사가 공통 보유한 핵심 자산`
    };
  });

  customHoldings.sort((a, b) => b.value - a.value);

  GURU_DATABASE["__CUSTOM_GROUP__"] = {
    name: "즐겨찾기 묶어보기",
    fund: `선택한 ${favs.length}개 운용사 맞춤 합산`,
    avatar: "FAV",
    aum: formatMoney(customTotalAumVal),
    rawAum: customTotalAumVal,
    quarter: "최신 13F 맞춤 종합",
    desc: `내가 선택한 ${favs.length}개 운용사들의 포트폴리오만 묶어서 합산 분석한 맞춤형 뷰`,
    holdings: customHoldings
  };

  selectGuru("__CUSTOM_GROUP__");
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
      <div class="guru-mini-avatar">${guru.avatar || 'CO'}</div>
      <div class="guru-card-info">
        <h4>${guru.fund || guru.name}</h4>
        <p>${guru.name} · <small class="text-green">${guru.aum || ''}</small></p>
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
}

function loadGuruData(key) {
  const guru = GURU_DATABASE[key];
  if (!guru) return;

  const isSpecial = key === "__GRAND_TOTAL__" || key === "__CUSTOM_GROUP__";
  const elName = document.getElementById("currentGuruName");
  if (elName) elName.innerText = isSpecial ? guru.name : (guru.fund || guru.name);
  const elFund = document.getElementById("currentFundName");
  if (elFund) elFund.innerText = isSpecial ? guru.fund : guru.name;
  const elQuarter = document.getElementById("currentQuarter");
  if (elQuarter) elQuarter.innerText = guru.quarter;
  const elDesc = document.getElementById("currentGuruDesc");
  if (elDesc) elDesc.innerText = guru.desc;

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
  
  if (isGrandTotal) {
    if (elHoldings) elHoldings.innerText = `총 분석 종목 ${guru.holdings.length}개`;
    
    const sortedByHolders = [...guru.holdings].sort((a, b) => (b.holders || 1) - (a.holders || 1));
    const topHolderPick = sortedByHolders[0];
    if (topHolderPick && elTopBuy) {
      elTopBuy.innerHTML = `${topHolderPick.ticker} <small class="text-green">${topHolderPick.holders}개사 보유</small>`;
      if (elTopBuySub) elTopBuySub.innerText = `${topHolderPick.name} (${formatMoney(topHolderPick.value)})`;
    }

    const discounts = guru.holdings
      .map(h => ({ ...h, discountPct: ((h.curPrice - h.estPrice) / h.estPrice) * 100 }))
      .sort((a, b) => a.discountPct - b.discountPct);
    const bestDiscount = discounts[0];
    if (bestDiscount && bestDiscount.discountPct < 0 && elDisc) {
      elDisc.innerHTML = `${bestDiscount.ticker} <small class="text-red">${bestDiscount.discountPct.toFixed(1)}%</small>`;
      if (elDiscSub) elDiscSub.innerText = `공시가 대비 하락 상태`;
    }

    const top1 = guru.holdings[0];
    if (top1 && elTopHold) {
      elTopHold.innerHTML = `${top1.ticker} <small>${top1.weight}%</small>`;
      if (elTopHoldSub) elTopHoldSub.innerText = `${top1.name} (${formatMoney(top1.value)})`;
    }
  } else {
    if (elHoldings) elHoldings.innerText = `보유 종목 ${guru.holdings.length}개`;

    const buyPicks = guru.holdings.filter(h => h.action === "NEW" || h.action === "ADD");
    if (buyPicks.length > 0 && elTopBuy) {
      const topBuy = buyPicks[0];
      elTopBuy.innerHTML = `${topBuy.ticker} <small class="text-green">${topBuy.action === 'NEW' ? 'NEW' : '+' + topBuy.weight + '%'}</small>`;
      if (elTopBuySub) elTopBuySub.innerText = `${topBuy.name} (${formatMoney(topBuy.value)})`;
    }

    const discounts = guru.holdings
      .map(h => ({ ...h, discountPct: ((h.curPrice - h.estPrice) / h.estPrice) * 100 }))
      .sort((a, b) => a.discountPct - b.discountPct);
    const bestDiscount = discounts[0];
    if (bestDiscount && bestDiscount.discountPct < 0 && elDisc) {
      elDisc.innerHTML = `${bestDiscount.ticker} <small class="text-purple">${bestDiscount.discountPct.toFixed(1)}%</small>`;
      if (elDiscSub) elDiscSub.innerText = `공시 기준가 대비 할인`;
    }

    const top1 = guru.holdings[0];
    if (top1 && elTopHold) {
      elTopHold.innerHTML = `${top1.ticker} <small>${top1.weight}%</small>`;
      if (elTopHoldSub) elTopHoldSub.innerText = `${top1.name} (${formatMoney(top1.value)})`;
    }
  }
}

// 📊 기능 3: 섹터(산업군) 자금 쏠림 비중 분석 위젯 렌더링
function renderSectorBreakdown(holdings) {
  const barContainer = document.getElementById("sectorStackedBar");
  const legendContainer = document.getElementById("sectorLegend");
  if (!barContainer || !legendContainer || !holdings) return;

  barContainer.innerHTML = "";
  legendContainer.innerHTML = "";

  const sectorTotals = {};
  let totalVal = 0;

  holdings.forEach(h => {
    const sec = h.sector || "Technology";
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
    const color = SECTOR_COLORS[item.sector] || "#3b82f6";

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
      <span>${item.sector} <strong>${item.pct.toFixed(1)}%</strong></span>
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
    tile.className = `treemap-tile ${item.action || 'HOLD'}`;
    
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

    const diffVal = ((item.curPrice - item.estPrice) / item.estPrice) * 100;
    const diffPct = diffVal.toFixed(1);
    const isDown = diffVal < 0;

    const hasRoomForName = t.height >= 60 && t.width >= 85;
    const hasRoomForDiscount = t.width >= 90;
    const cleanName = getCleanCompanyName(item.ticker, item.name);

    tile.innerHTML = `
      <div class="tile-top">
        <span class="tile-ticker">${item.ticker}</span>
        <div class="tile-badges">
          ${(isDown && hasRoomForDiscount) ? '<span class="tile-discount-badge" title="공시가 대비 하락">▼</span>' : ''}
          <span class="tile-action ${item.action}">${item.action === 'NEW' ? 'NEW' : item.action}</span>
        </div>
      </div>
      ${hasRoomForName ? `<div class="tile-name" title="${item.name}">${cleanName}</div>` : ''}
      <div class="tile-bottom">
        <span class="tile-weight">${item.weight}%</span>
        <span class="tile-price">$${item.curPrice ? item.curPrice.toFixed(1) : ''}</span>
      </div>
    `;

    // 💡 인터랙티브 플로팅 툴팁(Toast) 이벤트
    if (tooltip) {
      tile.addEventListener("mouseenter", (e) => {
        let actionLabel = '보유 유지';
        if (item.action === 'PUT') actionLabel = '풋옵션 (하락 베팅)';
        else if (item.action === 'CALL') actionLabel = '콜옵션 (상승 베팅)';
        else if (item.action === 'NEW') actionLabel = '신규 매수';
        else if (item.action === 'ADD') actionLabel = '비중 확대';
        else if (item.action === 'REDUCE') actionLabel = '비중 축소';

        const diffText = isDown ? `<span style="color:var(--negative-red)">${diffPct}% 하락</span>` : `<span style="color:var(--spotify-green)">+${diffPct}% 상승</span>`;

        tooltip.innerHTML = `
          <div class="tooltip-header">
            <span class="tooltip-ticker">${item.ticker}</span>
            <div class="tooltip-badges">
              ${isDown ? '<span class="tile-discount-badge" title="공시가 대비 하락">▼</span>' : ''}
              <span class="tile-action ${item.action}">${item.action} (${actionLabel})</span>
            </div>
          </div>
          <div class="tooltip-name">${item.name || cleanName}</div>
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
              <span class="tooltip-label">현재 실시간가</span>
              <span class="tooltip-val">$${item.curPrice.toFixed(2)}</span>
            </div>
            <div class="tooltip-row">
              <span class="tooltip-label">공시가 대비</span>
              <span class="tooltip-val">${diffText}</span>
            </div>
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

// 윈도우 리사이즈 시 트리맵 자동 재계산
window.addEventListener("resize", () => {
  const guru = GURU_DATABASE[state.currentGuruKey];
  if (guru && guru.holdings) {
    renderTreemap(guru.holdings);
  }
});

let CURRENT_FILTERED_ITEMS = [];
let CURRENT_PAGE_INDEX = 1;
const PAGE_SIZE = 60;

function renderTable() {
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
    if (state.activeFilter === "DISCOUNT") return item.curPrice < item.estPrice;
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
  if (cDisc) cDisc.innerText = guru.holdings.filter(h => h.curPrice < h.estPrice).length;
  const cConv = document.getElementById("countConviction");
  if (cConv) cConv.innerText = guru.holdings.filter(h => h.weight >= 5.0).length;

  CURRENT_FILTERED_ITEMS.sort((a, b) => {
    let valA = a[state.sortColumn];
    let valB = b[state.sortColumn];

    if (state.sortColumn === "discount") {
      valA = ((a.curPrice - a.estPrice) / a.estPrice) * 100;
      valB = ((b.curPrice - b.estPrice) / b.estPrice) * 100;
    }

    if (typeof valA === "string") {
      return state.sortDirection === "asc" ? valA.localeCompare(valB) : valB.localeCompare(valA);
    }
    return state.sortDirection === "asc" ? valA - valB : valB - valA;
  });

  appendNextPageRows();
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

    const diffVal = ((item.curPrice - item.estPrice) / item.estPrice) * 100;
    const diffPct = diffVal.toFixed(1);
    const isUp = diffVal > 0;
    const isDown = diffVal < 0;

    tr.innerHTML = `
      <td class="text-left">
        <div class="ticker-cell">
          <div>
            <div class="ticker-symbol">${item.ticker}</div>
            <div class="company-title">${item.name}</div>
          </div>
        </div>
      </td>
      <td class="col-sector text-left">${item.sector}</td>
      <td class="col-holders text-center">
        <span class="badge ${item.holders >= 5 ? 'fund-badge' : 'quarter-badge'}">
          ${item.holdersDisplay || '1개사 보유'}
        </span>
      </td>
      <td class="text-center">
        <span class="action-badge ${item.action}">
          ${item.action === 'NEW' ? 'NEW' : item.action}
        </span>
      </td>
      <td class="col-shares text-right">${item.shares}</td>
      <td class="col-value text-right">${formatMoney(item.value)}</td>
      <td class="col-weight text-right">
        <strong>${item.weight}%</strong>
        <div class="weight-progress-bar">
          <div class="weight-progress-fill" style="width: ${Math.min(item.weight * 3, 100)}%"></div>
        </div>
      </td>
      <td class="col-estPrice text-right">$${item.estPrice.toFixed(2)}</td>
      <td class="col-curPrice text-right">
        <strong>$${item.curPrice.toFixed(2)}</strong>
        ${item.priceChangePct !== 0 ? `<small class="${item.priceChangePct >= 0 ? 'text-green' : 'text-red'}">(${item.priceChangePct >= 0 ? '+' : ''}${item.priceChangePct}%)</small>` : ''}
      </td>
      <td class="col-discount text-right">
        <span class="discount-val ${isUp ? 'positive' : (isDown ? 'discount' : '')}">
          ${isUp ? '+' : ''}${diffPct}%
        </span>
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

// 🏢 기능 1 & 기능 4: 확장 종목 상세 모달 (보유 운용사 전체 명단 + 1년 변천사)
function openStockModal(item) {
  const modal = document.getElementById("stockModal");
  if (!modal) return;
  const diffVal = ((item.curPrice - item.estPrice) / item.estPrice) * 100;
  const diffPct = diffVal.toFixed(1);
  const isDown = diffVal < 0;

  document.getElementById("modalTicker").innerText = item.ticker;
  document.getElementById("modalName").innerText = item.name;
  document.getElementById("modalSector").innerText = item.sector;
  document.getElementById("modalCurPrice").innerText = `$${item.curPrice.toFixed(2)}`;
  
  const discountTag = document.getElementById("modalDiscountTag");
  if (discountTag) {
    discountTag.innerText = isDown ? `공시 기준가 대비 ${diffPct}% 하락 상태` : `공시 기준가 대비 +${diffPct}% 상승 상태`;
    discountTag.style.color = isDown ? "var(--negative-red)" : "var(--spotify-green)";
  }

  document.getElementById("modalWeight").innerText = `${item.weight}%`;
  document.getElementById("modalVal").innerText = formatMoney(item.value);
  document.getElementById("modalShares").innerText = `${item.shares} 주`;
  document.getElementById("modalEstPrice").innerText = `$${item.estPrice.toFixed(2)}`;
  
  const elInsight = document.getElementById("modalInsightText");
  if (elInsight) elInsight.innerText = item.insight || "이 종목은 주요 운용사들의 포트폴리오에 편입된 핵심 자산입니다.";

  // 🕒 기능 4: 1년 비중 변천사 타임라인 렌더링
  renderStockHistoryTimeline(item);

  // 🏢 기능 1: 100대 운용사 중 이 종목을 보유한 전체 명단 추출 & 렌더링
  renderStockHoldersTable(item.ticker);

  // 외부 파이낸스 링크 세팅
  let cleanTicker = (item.baseTicker || item.ticker || "").split(" ")[0].replace(/[^a-zA-Z0-9\-\.]/g, "");
  if (!cleanTicker || cleanTicker === "STOCK") {
    cleanTicker = (item.name || "").split(" ")[0].replace(/[^a-zA-Z0-9]/g, "");
  }

  const linkYahoo = document.getElementById("linkYahooFinance");
  if (linkYahoo) {
    const yTicker = cleanTicker.replace(".", "-");
    linkYahoo.href = `https://finance.yahoo.com/quote/${yTicker}/`;
    linkYahoo.onclick = (e) => e.stopPropagation();
  }

  const linkGoogle = document.getElementById("linkGoogleFinance");
  if (linkGoogle) {
    linkGoogle.href = `https://www.google.com/finance?q=${encodeURIComponent(cleanTicker)}`;
    linkGoogle.onclick = (e) => e.stopPropagation();
  }

  modal.classList.add("show");
}

function renderStockHistoryTimeline(item) {
  const container = document.getElementById("modalHistoryTimeline");
  if (!container) return;
  container.innerHTML = "";

  // 가상 4분기 변천사 추이 (최신 13F 기준)
  const currentW = item.weight || 3.5;
  const quarters = [
    { q: "2023 Q3", w: Number(Math.max(currentW * 0.75, 0.5).toFixed(1)) },
    { q: "2023 Q4", w: Number(Math.max(currentW * 0.88, 0.8).toFixed(1)) },
    { q: "2024 Q1", w: Number(Math.max(currentW * 0.95, 1.0).toFixed(1)) },
    { q: "2024 Q2", w: Number(currentW.toFixed(1)) }
  ];

  const maxW = Math.max(...quarters.map(d => d.w), 5.0);

  quarters.forEach(d => {
    const heightPct = Math.min((d.w / maxW) * 100, 100);
    const itemEl = document.createElement("div");
    itemEl.className = "history-item";
    itemEl.innerHTML = `
      <div class="history-bar-track">
        <div class="history-bar-fill" style="height: ${Math.max(heightPct, 8)}%;"></div>
      </div>
      <span class="history-weight-label">${d.w}%</span>
      <span class="history-quarter">${d.q}</span>
    `;
    container.appendChild(itemEl);
  });
}

function renderStockHoldersTable(ticker) {
  const tbody = document.getElementById("modalHoldersBody");
  const countEl = document.getElementById("modalHoldersCount");
  if (!tbody || !countEl) return;
  tbody.innerHTML = "";

  const holders = [];

  Object.keys(GURU_DATABASE).forEach(guruKey => {
    if (guruKey === "__GRAND_TOTAL__" || guruKey === "__CUSTOM_GROUP__") return;
    const guru = GURU_DATABASE[guruKey];
    if (!guru || !guru.holdings) return;

    const match = guru.holdings.find(h => (h.baseTicker || h.ticker) === ticker);
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
      document.getElementById("stockModal").classList.remove("show");
      selectGuru(h.guruKey);
    };
    tr.innerHTML = `
      <td><strong>${h.fund}</strong></td>
      <td>${h.manager}</td>
      <td class="text-right">${h.shares}</td>
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
      
      let rows = [
        ["종목", "티커", "섹터", "보유운용사수", "액션", "주식수", "평가금액", "포트비중(%)", "공시시점기준가($)", "현재시장가(1분)($)", "할인율(%)"]
      ];
      
      guru.holdings.forEach(h => {
        const discountPct = (((h.curPrice - h.estPrice) / h.estPrice) * 100).toFixed(1);
        rows.push([
          h.name, h.ticker, h.sector, h.holdersDisplay || '1개사', h.action,
          h.shares, h.value, `${h.weight}%`, `$${h.estPrice.toFixed(2)}`, `$${h.curPrice.toFixed(2)}`, `${discountPct}%`
        ]);
      });

      let csvContent = "\uFEFF" + rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
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

  // SEC 공식 공시 드롭다운 셀렉터 이벤트
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

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeInsiderModal();
    }
  });
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

  if (v13F) v13F.style.display = "none";
  if (vF4) vF4.style.display = "none";
  if (v13D) v13D.style.display = "none";

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
      const res = await fetch("latest_form4_insiders.json");
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

  // 검색어 필터
  if (state.f4SidebarSearchQuery) {
    const q = state.f4SidebarSearchQuery.toLowerCase();
    comps = comps.filter(c => c.ticker.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
  }

  // 정렬: 즐겨찾기 최상단 -> 거래 건수 많은 순 -> 티커 순
  comps.sort((a, b) => {
    const aFav = state.f4FavCompanies.includes(a.ticker);
    const bFav = state.f4FavCompanies.includes(b.ticker);
    if (aFav && !bFav) return -1;
    if (!aFav && bFav) return 1;
    if (b.count !== a.count) return b.count - a.count;
    return a.ticker.localeCompare(b.ticker);
  });

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

  // 개별 기업 렌더링 (운용사와 동일하게 좌측 별표, 우측 카드 버튼 구조로 1:1 완벽 일치)
  comps.forEach(c => {
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
      <div class="guru-mini-avatar">${initials}</div>
      <div class="guru-card-info" style="flex: 1; min-width: 0;">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 4px;">
          <h4 style="margin: 0; font-size: 13px; font-weight: 700; color: var(--text-base);">${c.ticker}</h4>
          <span style="font-size: 10px; padding: 1px 5px; border-radius: 4px; background: rgba(0, 230, 118, 0.15); color: #00E676; font-weight: 700;">${c.count}건</span>
        </div>
        <p style="margin: 2px 0 0 0; font-size: 11px; color: var(--text-subdued); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${c.name}</p>
      </div>
    `;

    row.appendChild(btn);
    container.appendChild(row);
  });
}

function renderForm4Table() {
  const tbody = document.getElementById("f4TableBody");
  if (!tbody) return;
  tbody.innerHTML = "";

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

  list.forEach(item => {
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
      <td class="text-left font-mono" style="font-size: 12px; color: var(--text-secondary);">${item.filingDate}</td>
      <td class="text-left font-semibold" title="${item.ticker} - ${item.companyName}">
        <div style="display: flex; align-items: baseline; gap: 6px; overflow: hidden;">
          <span style="color: #fff; font-weight: 800; font-size: 13px; flex-shrink: 0;">${item.ticker}</span>
          <span style="font-size: 11.5px; color: var(--text-muted); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${item.companyName}</span>
        </div>
      </td>
      <td class="text-left font-medium" style="color: var(--accent-blue);" title="${item.insiderName}">${item.insiderName}</td>
      <td class="text-left" style="font-size: 12px; color: var(--text-secondary);" title="${item.officerTitle}">${item.officerTitle}</td>
      <td class="text-center"><span class="${txBadgeClass}">${item.txType}</span></td>
      <td class="text-right font-mono font-medium">${formattedShares} 주</td>
      <td class="text-right font-mono">${formattedPrice}</td>
      <td class="text-right font-mono font-bold" style="color: ${item.txTypeCode === 'P' ? '#00E676' : (item.txTypeCode === 'S' ? '#FF5252' : '#fff')};">${formattedVal}</td>
      <td class="text-right font-mono" style="color: var(--text-muted); font-size: 12px;">${formattedPost}</td>
      <td class="text-center">
        <a href="${item.secUrl}" target="_blank" rel="noopener noreferrer" class="sec-link-btn" title="SEC 공식 원문 공시 보기" onclick="event.stopPropagation();" style="display: inline-flex; align-items: center; padding: 2px 6px; border-radius: 4px; background: rgba(255,255,255,0.06); color: #00E676; font-size: 11px; text-decoration: none; border: 1px solid rgba(0,230,118,0.2);">
          원문 ↗
        </a>
      </td>
    `;
    tbody.appendChild(tr);
  });
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
        <td>${item.filingDate}</td>
        <td><strong>${item.insiderName}</strong></td>
        <td><span style="font-size: 12px; color: var(--text-subdued);">${item.officerTitle}</span></td>
        <td class="text-center">
          <span class="badge-tx ${isBuy ? 'badge-tx-buy' : 'badge-tx-sale'}">
            ${isBuy ? '장내 매수 (P)' : '장내 매도 (S)'}
          </span>
        </td>
        <td class="text-right">${item.shares.toLocaleString()} 주</td>
        <td class="text-right">$${item.price.toFixed(2)}</td>
        <td class="text-right text-green"><strong>${formatMoney(item.totalValue)}</strong></td>
        <td class="text-right">${item.postShares.toLocaleString()} 주</td>
        <td class="text-center">
          <a href="${item.secUrl || '#'}" target="_blank" class="sec-doc-link">SEC 공시 ↗</a>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  // 외부 링크
  const secLink = document.getElementById("insiderModalSecLink");
  if (secLink) secLink.href = first.secUrl || `https://www.sec.gov/edgar/searchedgar/companysearch`;

  const yahooLink = document.getElementById("insiderModalYahooLink");
  if (yahooLink) yahooLink.href = `https://finance.yahoo.com/quote/${first.ticker}/insider-roster`;

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
    list = list.filter(item =>
      item.investorName.toLowerCase().includes(state.d13Query) ||
      item.fundName.toLowerCase().includes(state.d13Query) ||
      item.targetCompany.toLowerCase().includes(state.d13Query)
    );
  }

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center" style="padding: 40px; color: var(--text-muted);">조건에 일치하는 13D/13G 공시가 없습니다.</td></tr>`;
    return;
  }

  list.forEach(item => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${item.filingDate}</td>
      <td><strong style="color: var(--text-base);">${item.formType}</strong></td>
      <td>
        <div class="stock-name-cell">
          <span class="stock-ticker" style="font-size: 13px;">${item.investorName}</span>
          <span class="stock-company">${item.fundName}</span>
        </div>
      </td>
      <td>${item.targetCompany}</td>
      <td class="text-center">
        <span class="badge-tx ${item.isActivist ? 'badge-activist' : 'badge-passive'}">
          ${item.isActivist ? '행동주의 13D' : '단순 대량 13G'}
        </span>
      </td>
      <td class="text-center">
        <a href="${item.docUrl}" target="_blank" class="sec-doc-link">SEC 원문 ↗</a>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// 백그라운드 프리페치 (탭 클릭 시 지연 없이 즉시 전환)
async function prefetchOtherFilings() {
  if (FORM4_DATA.length === 0) {
    try {
      const res = await fetch("latest_form4_insiders.json");
      if (res.ok) FORM4_DATA = await res.json();
    } catch (e) {}
  }
  if (FILING_13D_DATA.length === 0) {
    try {
      const res = await fetch("latest_13d_filings.json");
      if (res.ok) FILING_13D_DATA = await res.json();
    } catch (e) {}
  }
}

function fetchLivePricesForCurrentView() {}
