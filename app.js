/**
 * ==============================================================================
 * Alpha13F - 100대 운용사 포트폴리오 인텔리전스 (프론트엔드 엔진)
 * ==============================================================================
 */

let GURU_DATABASE = {};
let RAW_HOLDINGS = [];
let LIVE_PRICES = {};

// 즐겨찾기 로컬 저장소 키
const FAVORITES_STORAGE_KEY = "alpha13f_favorite_gurus";

function getFavorites() {
  try {
    const saved = localStorage.getItem(FAVORITES_STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch (e) {
    return [];
  }
}

function saveFavorites(favs) {
  try {
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favs));
  } catch (e) {}
}

function toggleFavorite(guruKey) {
  let favs = getFavorites();
  if (favs.includes(guruKey)) {
    favs = favs.filter(k => k !== guruKey);
  } else {
    favs.push(guruKey);
  }
  saveFavorites(favs);
  renderCategoryTabs();
  renderGuruSidebar();
}

// 주요 기업 공식 미국 티커 매핑 사전
const TICKER_MAP = {
  "MICRON": "MU",
  "STATE": "STT",
  "INVESC": "QQQ",
  "TAIWAN": "TSM",
  "BERKSH": "BRK-B",
  "ALPHAB": "GOOGL",
  "MICRON TECHNOLOGY": "MU",
  "STATE STREET": "STT",
  "INVESCO QQQ": "QQQ",
  "TAIWAN SEMICONDUCTOR": "TSM",
  "BROADCOM": "AVGO",
  "META PLATFORMS": "META",
  "BERKSHIRE HATHAWAY": "BRK-B",
  "COSTCO WHOLESALE": "COST",
  "ADVANCED MICRO DEVICES": "AMD",
  "ASML HOLDING": "ASML",
  "ALPHABET": "GOOGL",
  "APPLE": "AAPL",
  "MICROSOFT": "MSFT",
  "NVIDIA": "NVDA",
  "AMAZON": "AMZN",
  "TESLA": "TSLA",
  "COCA COLA": "KO",
  "PEPSICO": "PEP",
  "AMERICAN EXPRESS": "AXP",
  "BANK OF AMERICA": "BAC",
  "JPMORGAN CHASE": "JPM",
  "WELLS FARGO": "WFC",
  "OCCIDENTAL PETROLEUM": "OXY",
  "CHEVRON": "CVX",
  "EXXON MOBIL": "XOM",
  "ELI LILLY": "LLY",
  "NOVO NORDISK": "NVO",
  "WALMART": "WMT",
  "PROCTER & GAMBLE": "PG",
  "JOHNSON & JOHNSON": "JNJ",
  "UNITEDHEALTH": "UNH",
  "VISA": "V",
  "MASTERCARD": "MA",
  "NETFLIX": "NFLX",
  "WALT DISNEY": "DIS",
  "SALESFORCE": "CRM",
  "ADOBE": "ADBE",
  "ORACLE": "ORCL",
  "QUALCOMM": "QCOM",
  "INTEL": "INTC",
  "CISCO SYSTEMS": "CSCO",
  "TEXAS INSTRUMENTS": "TXN",
  "SPDR S&P 500": "SPY"
};

function getMappedTicker(name, rawTicker) {
  const upperName = (name || "").toUpperCase();
  const upperTicker = (rawTicker || "").toUpperCase();

  for (const [key, val] of Object.entries(TICKER_MAP)) {
    if (upperName.includes(key) || upperTicker.includes(key) || upperTicker === key) {
      return val;
    }
  }

  const invalidTickers = ["STATE", "INVESC", "MICRON", "BERKSH", "TAIWAN", "ALPHAB"];
  if (rawTicker && rawTicker.length <= 5 && !rawTicker.includes(" ") && /^[A-Z]+$/.test(rawTicker) && !invalidTickers.includes(rawTicker)) {
    return rawTicker;
  }

  return (name || "STOCK").split(" ")[0].toUpperCase().slice(0, 6);
}

// 금액 단위 포맷팅 헬퍼 ($1,000 기준 -> $M, $B, $T)
function formatMoney(thousandsVal) {
  if (!thousandsVal || thousandsVal <= 0) return "$0";
  const actualUsd = thousandsVal * 1000;
  if (actualUsd >= 1e12) {
    return `$${(actualUsd / 1e12).toFixed(2)}T`;
  } else if (actualUsd >= 1e9) {
    return `$${(actualUsd / 1e9).toFixed(2)}B`;
  } else if (actualUsd >= 1e6) {
    return `$${(actualUsd / 1e6).toFixed(1)}M`;
  }
  return `$${thousandsVal.toLocaleString()}K`;
}

// 증권 유형 판별 (보통주, CALL, PUT, NOTE)
function detectSecType(name, ticker, titleOfClass) {
  const text = `${name || ''} ${ticker || ''} ${titleOfClass || ''}`.toUpperCase();
  if (text.includes("PUT") || text.includes(" PUT ")) return "PUT";
  if (text.includes("CALL") || text.includes(" CALL ")) return "CALL";
  if (text.includes("NOTE") || text.includes("PRN") || text.includes("BOND")) return "NOTE";
  return "STOCK";
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

document.addEventListener("DOMContentLoaded", async () => {
  try {
    // 초기 접속 시 즐겨찾기 기본값 (버핏, 애크먼, 달리오, 버리, 드러켄밀러)
    if (!localStorage.getItem(FAVORITES_STORAGE_KEY)) {
      saveFavorites(["Warren Buffett", "Bill Ackman", "Ray Dalio", "Michael Burry", "Stanley Druckenmiller"]);
    }

    await loadRealSecData();
    renderCategoryTabs();
    renderGuruSidebar();
    loadGuruData("__GRAND_TOTAL__");
    setupEventListeners();

    setInterval(() => {
      fetchLivePricesForCurrentView();
    }, 60000);
  } catch (err) {
    console.error("초기화 오류:", err);
  }
});

async function fetchLivePricesForCurrentView() {
  const guru = GURU_DATABASE[state.currentGuruKey];
  if (!guru || !guru.holdings) return;

  const topTickers = guru.holdings.slice(0, 30).map(h => h.baseTicker || h.ticker).filter(t => t && t.length <= 5 && !t.includes(" ")).join(",");
  if (!topTickers) return;

  try {
    const res = await fetch(`/api/prices?tickers=${topTickers}`).catch(() => null);
    if (res && res.ok) {
      const data = await res.json();
      Object.keys(data).forEach(t => {
        LIVE_PRICES[t] = data[t];
      });
      applyLivePricesToHoldings(guru.holdings);
      updateSummaryMetrics(guru);
      renderTable();
    }
  } catch (e) {}
}

function applyLivePricesToHoldings(holdings) {
  if (!holdings) return;
  holdings.forEach(h => {
    const baseT = h.baseTicker || h.ticker;
    if (LIVE_PRICES[baseT]) {
      const info = LIVE_PRICES[baseT];
      h.curPrice = info.price;
      h.priceChangePct = info.changePct;
    }
  });
}

async function loadRealSecData() {
  try {
    const [holdingsRes, priceRes] = await Promise.all([
      fetch("latest_13f_holdings.json"),
      fetch("realtime_prices.json").catch(() => null)
    ]);

    if (!holdingsRes.ok) throw new Error("13F JSON 로드 실패");
    RAW_HOLDINGS = await holdingsRes.json();
    
    if (priceRes && priceRes.ok) {
      try {
        LIVE_PRICES = await priceRes.json();
      } catch (e) {}
    }
    
    const groups = {};
    const grandConsensusMap = {};
    let grandTotalAumVal = 0;
    
    RAW_HOLDINGS.forEach(item => {
      const guruName = item.guru || "기타 운용사";
      if (!groups[guruName]) {
        const initials = guruName.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
        groups[guruName] = {
          name: guruName,
          avatar: initials || "CO",
          fund: item.fund || guruName,
          quarter: `${item.period || '2024Q2'} Filing`,
          desc: `${item.fund || guruName}의 최신 13F 공식 보유 지분 공시 포트폴리오`,
          holdingsMap: {}
        };
      }
      
      const secType = detectSecType(item.name, item.ticker, item.titleOfClass);
      const baseTicker = getMappedTicker(item.name, item.ticker);
      const cusip = item.cusip || item.name || "UNKNOWN";

      const uniqueKey = `${cusip}_${secType}`;
      const hMap = groups[guruName].holdingsMap;

      let displayTicker = baseTicker;
      if (secType === "CALL") displayTicker = `${baseTicker} (CALL)`;
      else if (secType === "PUT") displayTicker = `${baseTicker} (PUT)`;

      const itemShares = Number(item.shares) || 0;
      const itemVal = Number(item.value) || 0;

      if (!hMap[uniqueKey]) {
        hMap[uniqueKey] = {
          ticker: displayTicker,
          baseTicker: baseTicker,
          name: item.name || baseTicker,
          sector: item.sector || "General",
          secType: secType,
          shares: itemShares,
          value: itemVal,
          cusip: cusip
        };
      } else {
        hMap[uniqueKey].shares += itemShares;
        hMap[uniqueKey].value += itemVal;
      }

      if (!grandConsensusMap[uniqueKey]) {
        grandConsensusMap[uniqueKey] = {
          ticker: displayTicker,
          baseTicker: baseTicker,
          name: item.name || baseTicker,
          sector: item.sector || "General",
          secType: secType,
          cusip: cusip,
          shares: itemShares,
          value: itemVal,
          holders: new Set([guruName])
        };
      } else {
        grandConsensusMap[uniqueKey].shares += itemShares;
        grandConsensusMap[uniqueKey].value += itemVal;
        grandConsensusMap[uniqueKey].holders.add(guruName);
      }
      
      grandTotalAumVal += itemVal;
    });

    Object.keys(groups).forEach(key => {
      const g = groups[key];
      const holdingList = Object.values(g.holdingsMap);
      const totalVal = holdingList.reduce((sum, h) => sum + h.value, 0);
      g.aum = formatMoney(totalVal);
      
      g.holdings = holdingList.map(h => {
        const weight = totalVal > 0 ? Number(((h.value / totalVal) * 100).toFixed(2)) : 0;
        const estP = h.shares > 0 ? (h.value / h.shares) : 100.0;
        
        const realInfo = LIVE_PRICES[h.baseTicker] || LIVE_PRICES[h.ticker];
        const curP = (realInfo && realInfo.price) ? realInfo.price : estP;
        
        let action = "HOLD";
        if (weight >= 8.0) action = "ADD";
        else if (weight >= 15.0) action = "NEW";

        let typeDesc = "보통주 주식";
        if (h.secType === "CALL") typeDesc = "콜옵션(상승 베팅/레버리지)";
        else if (h.secType === "PUT") typeDesc = "풋옵션(하락 방어/헤지)";
        
        return {
          ticker: h.ticker,
          baseTicker: h.baseTicker,
          name: h.name,
          sector: h.sector,
          secType: h.secType,
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
          insight: `${h.name} [${typeDesc}] - ${g.name} 포트폴리오의 ${weight}% 차지 (기초자산 시장 현재가: $${curP})`
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
      
      let action = "HOLD";
      if (h.holders.size >= 5) action = "ADD";
      if (weight >= 5.0) action = "NEW";

      let typeDesc = "보통주 주식";
      if (h.secType === "CALL") typeDesc = "콜옵션(상승 베팅)";
      else if (h.secType === "PUT") typeDesc = "풋옵션(하락 방어)";
      
      return {
        ticker: h.ticker,
        baseTicker: h.baseTicker,
        name: h.name,
        sector: h.sector,
        secType: h.secType,
        cusip: h.cusip,
        holders: h.holders.size,
        holdersDisplay: `${h.holders.size}개사 보유`,
        holderNames: Array.from(h.holders),
        action: action,
        shares: h.shares >= 1000000 ? `${(h.shares / 1000000).toFixed(2)}M` : `${(h.shares / 1000).toFixed(1)}K`,
        rawShares: h.shares,
        value: h.value,
        weight: weight,
        estPrice: estP,
        curPrice: curP,
        priceChangePct: realInfo ? realInfo.changePct : 0.0,
        insight: `미국 주요 운용사 ${h.holders.size}개사가 집중 보유 중인 ${typeDesc} 핵심 포지션 (${Array.from(h.holders).slice(0, 3).join(", ")} 등) | 시장 현재가: $${curP}`
      };
    });

    grandHoldings.sort((a, b) => b.value - a.value);

    groups["__GRAND_TOTAL__"] = {
      name: "전체 운용사 통합 포트폴리오 (Grand Total)",
      avatar: "CO",
      fund: "100개 주요 운용사 총합",
      quarter: "최신 13F 공시 종합 분석",
      desc: "미국 1억 달러 이상 운용 자격을 갖춘 100개 주요 운용사의 포트폴리오를 하나로 통합 분석한 거대 자금 흐름",
      aum: formatMoney(grandTotalAumVal),
      holdings: grandHoldings
    };

    GURU_DATABASE = groups;
  } catch (e) {
    console.error("데이터 로드 실패:", e);
  }
}

// 🎛️ 선택된 즐겨찾기 운용사들만의 커스텀 통합 포트폴리오 실시간 생성
function buildCustomGroupPortfolio() {
  const favs = getFavorites();
  if (favs.length === 0) {
    alert("즐겨찾기로 선택된 운용사가 없습니다! 운용사 목록에서 별표(★)를 눌러 추가해 보세요.");
    return;
  }

  const customConsensusMap = {};
  let customAumVal = 0;

  favs.forEach(guruKey => {
    const guru = GURU_DATABASE[guruKey];
    if (!guru || !guru.holdings) return;

    guru.holdings.forEach(h => {
      const key = `${h.cusip}_${h.secType}`;
      if (!customConsensusMap[key]) {
        customConsensusMap[key] = {
          ticker: h.ticker,
          baseTicker: h.baseTicker,
          name: h.name,
          sector: h.sector,
          secType: h.secType,
          cusip: h.cusip,
          shares: h.rawShares || 0,
          value: h.value || 0,
          holders: new Set([guru.name])
        };
      } else {
        customConsensusMap[key].shares += (h.rawShares || 0);
        customConsensusMap[key].value += (h.value || 0);
        customConsensusMap[key].holders.add(guru.name);
      }
      customAumVal += (h.value || 0);
    });
  });

  const customHoldings = Object.values(customConsensusMap).map(h => {
    const weight = customAumVal > 0 ? Number(((h.value / customAumVal) * 100).toFixed(2)) : 0;
    const estP = h.shares > 0 ? (h.value / h.shares) : 100.0;
    
    const realInfo = LIVE_PRICES[h.baseTicker] || LIVE_PRICES[h.ticker];
    const curP = (realInfo && realInfo.price) ? realInfo.price : estP;
    
    let action = "HOLD";
    if (h.holders.size >= 2) action = "ADD";
    if (weight >= 5.0) action = "NEW";

    return {
      ticker: h.ticker,
      baseTicker: h.baseTicker,
      name: h.name,
      sector: h.sector,
      secType: h.secType,
      cusip: h.cusip,
      holders: h.holders.size,
      holdersDisplay: `${h.holders.size}/${favs.length}개사 보유`,
      holderNames: Array.from(h.holders),
      action: action,
      shares: h.shares >= 1000000 ? `${(h.shares / 1000000).toFixed(2)}M` : `${(h.shares / 1000).toFixed(1)}K`,
      rawShares: h.shares,
      value: h.value,
      weight: weight,
      estPrice: estP,
      curPrice: curP,
      priceChangePct: realInfo ? realInfo.changePct : 0.0,
      insight: `선택하신 ${favs.length}개사 중 ${h.holders.size}개사가 집중 보유 중인 포지션`
    };
  });

  customHoldings.sort((a, b) => b.value - a.value);

  GURU_DATABASE["__CUSTOM_GROUP__"] = {
    name: `내 즐겨찾기 ${favs.length}개사 맞춤 통합 포트폴리오`,
    avatar: "VIP",
    fund: `선택 운용사: ${favs.slice(0, 3).join(", ")}${favs.length > 3 ? ` 외 ${favs.length - 3}곳` : ''}`,
    quarter: "13F 맞춤 실시간 합산",
    desc: `내가 직접 선택한 ${favs.length}개 주요 운용사의 포트폴리오를 합산하여 분석한 맞춤형 자금 흐름`,
    aum: formatMoney(customAumVal),
    holdings: customHoldings
  };

  selectGuru("__CUSTOM_GROUP__");
}

function renderTreemap(holdings) {
  const container = document.getElementById("treemapContainer");
  if (!container) return;
  container.innerHTML = "";

  if (!holdings || holdings.length === 0) {
    container.innerHTML = `<div style="padding:40px; color:var(--text-subdued); text-align:center; width:100%;">표시할 포트폴리오 데이터가 없습니다.</div>`;
    return;
  }

  const sorted = [...holdings].sort((a, b) => b.weight - a.weight);
  const mainHoldings = sorted.filter(h => h.weight >= 0.4).slice(0, 24);
  const tinyHoldings = sorted.slice(24);

  mainHoldings.forEach(item => {
    const tile = document.createElement("div");
    let sizeClass = "tile-small";
    let flexGrow = Math.max(item.weight * 3, 10);
    let flexBasis = 140;

    if (item.weight >= 10.0) {
      sizeClass = "tile-large";
      flexGrow = item.weight * 6;
      flexBasis = 280;
    } else if (item.weight >= 3.0) {
      sizeClass = "tile-medium";
      flexGrow = item.weight * 4.5;
      flexBasis = 200;
    }

    const isDiscount = item.curPrice < item.estPrice;
    tile.className = `tree-tile ${sizeClass} action-${item.action}`;
    tile.style.flex = `${flexGrow} 1 ${flexBasis}px`;
    tile.onclick = () => openStockModal(item);

    let typeTag = "";
    if (item.secType === "CALL") typeTag = '<span class="sec-type-badge call">CALL</span>';
    else if (item.secType === "PUT") typeTag = '<span class="sec-type-badge put">PUT</span>';

    tile.innerHTML = `
      <div class="tile-top">
        <span class="tile-ticker">${item.ticker}${typeTag}</span>
        <span class="tile-weight">${item.weight}%</span>
      </div>
      <div class="tile-bottom">
        <span class="tile-name" title="${item.name}">${item.name}</span>
        <div class="tile-tags">
          ${isDiscount ? '<span class="discount-pill">할인</span>' : ''}
          <span class="tile-action-tag ${item.action}">${item.action}</span>
        </div>
      </div>
    `;
    container.appendChild(tile);
  });

  if (tinyHoldings.length > 0) {
    const tinyTotalWeight = tinyHoldings.reduce((sum, h) => sum + h.weight, 0).toFixed(2);
    const otherTile = document.createElement("div");
    otherTile.className = "tree-tile tile-small action-HOLD";
    otherTile.style.flex = "15 1 150px";
    otherTile.innerHTML = `
      <div class="tile-top">
        <span class="tile-ticker" style="color: var(--text-muted); font-size: 0.9rem;">기타 소량 보유</span>
        <span class="tile-weight">${tinyTotalWeight}%</span>
      </div>
      <div class="tile-bottom">
        <span class="tile-name">${tinyHoldings.length}개 종목 합산</span>
        <span class="tile-action-tag HOLD">${tinyHoldings.length}개</span>
      </div>
    `;
    otherTile.onclick = () => {
      alert(`기타 소량 보유 ${tinyHoldings.length}개 종목은 하단 테이블에서 검색 및 확인하실 수 있습니다.`);
    };
    container.appendChild(otherTile);
  }
}

function renderCategoryTabs() {
  const sidebarBox = document.querySelector(".guru-selector-box");
  if (!sidebarBox) return;

  let catContainer = document.getElementById("guruCatFilters");
  const favCount = getFavorites().length;

  if (!catContainer) {
    catContainer = document.createElement("div");
    catContainer.id = "guruCatFilters";
    catContainer.className = "guru-cat-filters";
    
    // 커스텀 묶어보기 버튼 및 필터 탭
    catContainer.innerHTML = `
      <button class="custom-group-btn" id="btnCustomGroup">★ 즐겨찾기 ${favCount}개사 묶어보기</button>
      <div style="display:flex; gap:4px; margin-bottom:8px;">
        <button class="cat-pill active" data-cat="ALL">전체 100개사</button>
        <button class="cat-pill" data-cat="FAV">★ 내 즐겨찾기 (<span id="favPillCount">${favCount}</span>)</button>
        <button class="cat-pill gold" data-cat="TOP20">Top 20</button>
      </div>
    `;

    const label = sidebarBox.querySelector(".section-label");
    if (label) {
      label.after(catContainer);
    }

    const btnCustom = document.getElementById("btnCustomGroup");
    if (btnCustom) {
      btnCustom.onclick = () => buildCustomGroupPortfolio();
    }

    catContainer.querySelectorAll(".cat-pill").forEach(btn => {
      btn.onclick = () => {
        catContainer.querySelectorAll(".cat-pill").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        state.activeCategory = btn.dataset.cat;
        renderGuruSidebar();
      };
    });
  } else {
    const fCountEl = document.getElementById("favPillCount");
    if (fCountEl) fCountEl.innerText = favCount;
    const btnCustom = document.getElementById("btnCustomGroup");
    if (btnCustom) btnCustom.innerText = `★ 즐겨찾기 ${favCount}개사 묶어보기`;
  }
}

function renderGuruSidebar() {
  const listEl = document.getElementById("guruList");
  if (!listEl) return;
  listEl.innerHTML = "";

  const btnGrand = document.getElementById("btnGrandTotal");
  if (btnGrand) {
    btnGrand.classList.toggle("active", state.currentGuruKey === "__GRAND_TOTAL__");
  }

  const btnCustom = document.getElementById("btnCustomGroup");
  if (btnCustom) {
    btnCustom.classList.toggle("active", state.currentGuruKey === "__CUSTOM_GROUP__");
  }

  const favs = getFavorites();

  Object.keys(GURU_DATABASE).filter(k => k !== "__GRAND_TOTAL__" && k !== "__CUSTOM_GROUP__").forEach(key => {
    const guru = GURU_DATABASE[key];
    const isFav = favs.includes(key);

    if (state.activeCategory === "FAV" && !isFav) return;

    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "4px";

    const starBtn = document.createElement("button");
    starBtn.className = `star-btn ${isFav ? 'starred' : ''}`;
    starBtn.innerHTML = isFav ? "★" : "☆";
    starBtn.title = isFav ? "즐겨찾기 해제" : "즐겨찾기 추가";
    starBtn.onclick = (e) => {
      e.stopPropagation();
      toggleFavorite(key);
    };

    const btn = document.createElement("button");
    btn.className = `guru-card-btn ${key === state.currentGuruKey ? 'active' : ''}`;
    btn.onclick = () => selectGuru(key);

    btn.innerHTML = `
      <div class="guru-mini-avatar">${guru.avatar || 'CO'}</div>
      <div class="guru-card-info">
        <h4>${guru.name}</h4>
        <p>${guru.fund}</p>
      </div>
    `;

    row.appendChild(starBtn);
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
  fetchLivePricesForCurrentView();
}

function loadGuruData(key) {
  const guru = GURU_DATABASE[key];
  if (!guru) return;

  const elName = document.getElementById("currentGuruName");
  if (elName) elName.innerText = guru.name;
  const elFund = document.getElementById("currentFundName");
  if (elFund) elFund.innerText = guru.fund;
  const elQuarter = document.getElementById("currentQuarter");
  if (elQuarter) elQuarter.innerText = guru.quarter;
  const elDesc = document.getElementById("currentGuruDesc");
  if (elDesc) elDesc.innerText = guru.desc;

  updateSummaryMetrics(guru);
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
      elDisc.innerHTML = `${bestDiscount.ticker} <small class="text-purple">${bestDiscount.discountPct.toFixed(1)}%</small>`;
      if (elDiscSub) elDiscSub.innerText = `공시 기준가 대비 할인 상태`;
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
    } else if (elTopBuy) {
      elTopBuy.innerText = "변동 없음";
      if (elTopBuySub) elTopBuySub.innerText = "신규/확대 매수 없음";
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

function renderTable() {
  const guru = GURU_DATABASE[state.currentGuruKey];
  if (!guru) return;

  const tbody = document.getElementById("tableBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  let filtered = guru.holdings.filter(item => {
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      const match = item.ticker.toLowerCase().includes(q) ||
                    item.name.toLowerCase().includes(q) ||
                    item.sector.toLowerCase().includes(q);
      if (!match) return false;
    }

    if (state.activeFilter === "STOCK") return item.secType === "STOCK";
    if (state.activeFilter === "OPTION") return item.secType === "CALL" || item.secType === "PUT";
    if (state.activeFilter === "NEW") return item.action === "NEW";
    if (state.activeFilter === "ADD") return item.action === "ADD";
    if (state.activeFilter === "DISCOUNT") return item.curPrice < item.estPrice;
    if (state.activeFilter === "CONVICTION") return item.weight >= 5.0;
    return true;
  });

  const cAll = document.getElementById("countAll");
  if (cAll) cAll.innerText = guru.holdings.length;
  const cStock = document.getElementById("countStock");
  if (cStock) cStock.innerText = guru.holdings.filter(h => h.secType === "STOCK").length;
  const cOption = document.getElementById("countOption");
  if (cOption) cOption.innerText = guru.holdings.filter(h => h.secType === "CALL" || h.secType === "PUT").length;
  const cNew = document.getElementById("countNew");
  if (cNew) cNew.innerText = guru.holdings.filter(h => h.action === "NEW").length;
  const cAdd = document.getElementById("countAdd");
  if (cAdd) cAdd.innerText = guru.holdings.filter(h => h.action === "ADD").length;
  const cDisc = document.getElementById("countDiscount");
  if (cDisc) cDisc.innerText = guru.holdings.filter(h => h.curPrice < h.estPrice).length;
  const cConv = document.getElementById("countConviction");
  if (cConv) cConv.innerText = guru.holdings.filter(h => h.weight >= 5.0).length;

  filtered.sort((a, b) => {
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

  filtered.forEach(item => {
    const tr = document.createElement("tr");
    tr.onclick = () => openStockModal(item);

    const discountPct = (((item.curPrice - item.estPrice) / item.estPrice) * 100).toFixed(1);
    const isDiscount = Number(discountPct) < 0;

    let secBadgeHtml = "";
    if (item.secType === "CALL") secBadgeHtml = `<span class="sec-type-badge call">CALL</span>`;
    else if (item.secType === "PUT") secBadgeHtml = `<span class="sec-type-badge put">PUT</span>`;

    tr.innerHTML = `
      <td>
        <div class="ticker-cell">
          <div>
            <div class="ticker-symbol">${item.ticker} ${secBadgeHtml}</div>
            <div class="company-title">${item.name}</div>
          </div>
        </div>
      </td>
      <td class="col-sector">${item.sector}</td>
      <td class="col-holders">
        <span class="badge ${item.holders >= 5 ? 'fund-badge' : 'quarter-badge'}">
          ${item.holdersDisplay || '1개사 보유'}
        </span>
      </td>
      <td>
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
        <span class="discount-val ${isDiscount ? 'discount' : 'positive'}">
          ${isDiscount ? discountPct + '%' : '+' + discountPct + '%'}
        </span>
      </td>
    `;
    tbody.appendChild(tr);
  });

  applyColumnVisibility();
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

function openStockModal(item) {
  const modal = document.getElementById("stockModal");
  if (!modal) return;
  const discountPct = (((item.curPrice - item.estPrice) / item.estPrice) * 100).toFixed(1);
  const isDiscount = Number(discountPct) < 0;

  document.getElementById("modalTicker").innerText = item.ticker;
  document.getElementById("modalName").innerText = item.name;
  document.getElementById("modalSector").innerText = item.sector;
  document.getElementById("modalCurPrice").innerText = `$${item.curPrice.toFixed(2)}`;
  
  const discountTag = document.getElementById("modalDiscountTag");
  if (discountTag) {
    discountTag.innerText = isDiscount ? `공시 기준가 대비 ${discountPct}% 할인 상태` : `공시 기준가 대비 +${discountPct}% 프리미엄`;
    discountTag.style.color = isDiscount ? "var(--color-purple)" : "var(--color-green)";
  }

  document.getElementById("modalWeight").innerText = `${item.weight}%`;
  document.getElementById("modalVal").innerText = formatMoney(item.value);
  document.getElementById("modalShares").innerText = `${item.shares} 주`;
  document.getElementById("modalEstPrice").innerText = `$${item.estPrice.toFixed(2)}`;
  
  const elInsight = document.getElementById("modalInsightText");
  if (elInsight) elInsight.innerText = item.insight || "이 종목은 주요 운용사들의 포트폴리오에 편입된 핵심 자산입니다.";

  modal.classList.add("show");
}

function setupEventListeners() {
  const btnGrand = document.getElementById("btnGrandTotal");
  if (btnGrand) {
    btnGrand.onclick = () => selectGuru("__GRAND_TOTAL__");
  }

  const btnClose = document.getElementById("btnModalClose");
  if (btnClose) {
    btnClose.onclick = () => {
      document.getElementById("stockModal").classList.remove("show");
    };
  }

  document.querySelectorAll(".nav-item").forEach(item => {
    item.onclick = () => {
      document.querySelectorAll(".nav-item").forEach(i => i.classList.remove("active"));
      item.classList.add("active");
      const tab = item.dataset.tab;
      if (tab === "consensus") {
        selectGuru("__GRAND_TOTAL__");
      } else if (tab === "discount") {
        state.activeFilter = "DISCOUNT";
        document.querySelectorAll(".filter-tab").forEach(f => f.classList.toggle("active", f.dataset.filter === "DISCOUNT"));
        renderTable();
      } else {
        state.activeFilter = "ALL";
        document.querySelectorAll(".filter-tab").forEach(f => f.classList.toggle("active", f.dataset.filter === "ALL"));
        renderTable();
      }
    };
  });

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

  const btnCols = document.getElementById("btnToggleCols");
  const colMenu = document.getElementById("colMenu");
  if (btnCols && colMenu) {
    btnCols.onclick = (e) => {
      e.stopPropagation();
      colMenu.classList.toggle("show");
    };

    document.addEventListener("click", () => {
      colMenu.classList.remove("show");
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
        ["종목", "티커", "증권유형", "섹터", "보유운용사수", "액션", "주식수", "평가금액", "포트비중(%)", "공시시점기준가($)", "현재시장가($)", "할인율(%)"]
      ];
      
      guru.holdings.forEach(h => {
        const discountPct = (((h.curPrice - h.estPrice) / h.estPrice) * 100).toFixed(1);
        rows.push([
          h.name, h.ticker, h.secType, h.sector, h.holdersDisplay || '1개사', h.action,
          h.shares, h.value, `${h.weight}%`, `$${h.estPrice.toFixed(2)}`, `$${h.curPrice.toFixed(2)}`, `${discountPct}%`
        ]);
      });

      let csvContent = "\uFEFF" + rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${guru.name.replace(/[^a-zA-Z0-9가-힣]/g, "_")}_포트폴리오.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };
  }
}
