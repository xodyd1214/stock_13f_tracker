/**
 * ==============================================================================
 * Alpha13F - 100대 운용사 포트폴리오 인텔리전스 (프론트엔드 엔진)
 * ==============================================================================
 */

let GURU_DATABASE = {};
let RAW_HOLDINGS = [];

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
  await loadRealSecData();
  renderCategoryTabs();
  renderGuruSidebar();
  loadGuruData("__GRAND_TOTAL__");
  setupEventListeners();
});

async function loadRealSecData() {
  try {
    const [holdingsRes, priceRes] = await Promise.all([
      fetch("latest_13f_holdings.json"),
      fetch("realtime_prices.json").catch(() => null)
    ]);

    if (!holdingsRes.ok) throw new Error("13F JSON 로드 실패");
    RAW_HOLDINGS = await holdingsRes.json();
    
    let REALTIME_PRICES = {};
    if (priceRes && priceRes.ok) {
      try {
        REALTIME_PRICES = await priceRes.json();
      } catch (e) {}
    }
    
    const groups = {};
    const grandConsensusMap = {};
    let grandTotalAumVal = 0;
    
    RAW_HOLDINGS.forEach(item => {
      const guruName = item.guru;
      if (!groups[guruName]) {
        const initials = guruName.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
        groups[guruName] = {
          name: guruName,
          avatar: initials || "CO",
          fund: item.fund,
          quarter: `${item.period} Filing`,
          desc: `${item.fund}의 최신 13F 공식 보유 지분 공시 포트폴리오`,
          holdingsMap: {}
        };
      }
      
      const cusip = item.cusip || item.name;
      const hMap = groups[guruName].holdingsMap;
      
      let displayTicker = item.ticker;
      if (!displayTicker || displayTicker === cusip) {
        displayTicker = item.name.split(" ")[0].toUpperCase().slice(0, 6);
      }

      if (!hMap[cusip]) {
        hMap[cusip] = {
          ticker: displayTicker,
          name: item.name,
          sector: item.sector || "General",
          shares: item.shares,
          value: item.value,
          cusip: cusip
        };
      } else {
        hMap[cusip].shares += item.shares;
        hMap[cusip].value += item.value;
      }

      if (!grandConsensusMap[displayTicker]) {
        grandConsensusMap[displayTicker] = {
          ticker: displayTicker,
          name: item.name,
          sector: item.sector || "General",
          cusip: cusip,
          shares: item.shares,
          value: item.value,
          holders: new Set([guruName])
        };
      } else {
        grandConsensusMap[displayTicker].shares += item.shares;
        grandConsensusMap[displayTicker].value += item.value;
        grandConsensusMap[displayTicker].holders.add(guruName);
      }
      
      grandTotalAumVal += item.value;
    });

    Object.keys(groups).forEach(key => {
      const g = groups[key];
      const holdingList = Object.values(g.holdingsMap);
      const totalVal = holdingList.reduce((sum, h) => sum + h.value, 0);
      g.aum = formatMoney(totalVal);
      
      g.holdings = holdingList.map(h => {
        const weight = totalVal > 0 ? Number(((h.value / totalVal) * 100).toFixed(2)) : 0;
        const estP = h.shares > 0 ? (h.value / h.shares) : 100.0;
        
        const realInfo = REALTIME_PRICES[h.ticker];
        const curP = (realInfo && realInfo.price) ? realInfo.price : estP;
        
        let action = "HOLD";
        if (weight >= 8.0) action = "ADD";
        else if (weight >= 15.0) action = "NEW";
        
        return {
          ticker: h.ticker,
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
          insight: `${h.name} (${h.ticker}) - ${g.name} 포트폴리오의 ${weight}% 차지 (실제 시장 현재가: $${curP})`
        };
      });

      g.holdings.sort((a, b) => b.weight - a.weight);
    });

    const grandList = Object.values(grandConsensusMap);
    const grandHoldings = grandList.map(h => {
      const weight = grandTotalAumVal > 0 ? Number(((h.value / grandTotalAumVal) * 100).toFixed(2)) : 0;
      const estP = h.shares > 0 ? (h.value / h.shares) : 100.0;
      
      const realInfo = REALTIME_PRICES[h.ticker];
      const curP = (realInfo && realInfo.price) ? realInfo.price : estP;
      
      let action = "HOLD";
      if (h.holders.size >= 5) action = "ADD";
      if (weight >= 5.0) action = "NEW";
      
      return {
        ticker: h.ticker,
        name: h.name,
        sector: h.sector,
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
        insight: `미국 주요 운용사 ${h.holders.size}개사가 동시 집중 보유 중인 핵심 종목 (${Array.from(h.holders).slice(0, 3).join(", ")} 등) | 실제 시장가: $${curP}`
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
    console.warn("데이터 로드 실패:", e);
  }
}

function renderTreemap(holdings) {
  const container = document.getElementById("treemapContainer");
  if (!container) return;
  container.innerHTML = "";

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

    tile.innerHTML = `
      <div class="tile-top">
        <span class="tile-ticker">${item.ticker}</span>
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

  const existingFilters = document.getElementById("guruCatFilters");
  if (existingFilters) return;

  const catContainer = document.createElement("div");
  catContainer.id = "guruCatFilters";
  catContainer.className = "guru-cat-filters";
  catContainer.innerHTML = `
    <button class="cat-pill active" data-cat="ALL">전체 100개사</button>
    <button class="cat-pill gold" data-cat="TOP20">Top 20 메이저</button>
  `;

  const label = sidebarBox.querySelector(".section-label");
  if (label) {
    label.after(catContainer);
  }

  catContainer.querySelectorAll(".cat-pill").forEach(btn => {
    btn.onclick = () => {
      catContainer.querySelectorAll(".cat-pill").forEach(b => b.classList.remove("active"));
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

  const btnGrand = document.getElementById("btnGrandTotal");
  if (btnGrand) {
    btnGrand.classList.toggle("active", state.currentGuruKey === "__GRAND_TOTAL__");
  }

  Object.keys(GURU_DATABASE).filter(k => k !== "__GRAND_TOTAL__").forEach(key => {
    const guru = GURU_DATABASE[key];
    const btn = document.createElement("button");
    btn.className = `guru-card-btn ${key === state.currentGuruKey ? 'active' : ''}`;
    btn.onclick = () => selectGuru(key);

    btn.innerHTML = `
      <div class="guru-mini-avatar">${guru.avatar}</div>
      <div class="guru-card-info">
        <h4>${guru.name}</h4>
        <p>${guru.fund}</p>
      </div>
    `;
    listEl.appendChild(btn);
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

  document.getElementById("currentGuruName").innerText = guru.name;
  document.getElementById("currentFundName").innerText = guru.fund;
  document.getElementById("currentQuarter").innerText = guru.quarter;
  document.getElementById("currentGuruDesc").innerText = guru.desc;

  updateSummaryMetrics(guru);
  renderTreemap(guru.holdings);
  renderTable();
}

function updateSummaryMetrics(guru) {
  document.getElementById("metricTotalAum").innerText = guru.aum;
  const isGrandTotal = state.currentGuruKey === "__GRAND_TOTAL__";
  
  if (isGrandTotal) {
    document.getElementById("metricTotalHoldings").innerText = `총 분석 종목 ${guru.holdings.length}개`;
    
    const sortedByHolders = [...guru.holdings].sort((a, b) => (b.holders || 1) - (a.holders || 1));
    const topHolderPick = sortedByHolders[0];
    if (topHolderPick) {
      document.getElementById("metricTopBuy").innerHTML = `${topHolderPick.ticker} <small class="text-green">${topHolderPick.holders}개사 보유</small>`;
      document.getElementById("metricTopBuySub").innerText = `${topHolderPick.name} (${formatMoney(topHolderPick.value)})`;
    }

    const discounts = guru.holdings
      .map(h => ({ ...h, discountPct: ((h.curPrice - h.estPrice) / h.estPrice) * 100 }))
      .sort((a, b) => a.discountPct - b.discountPct);
    const bestDiscount = discounts[0];
    if (bestDiscount && bestDiscount.discountPct < 0) {
      document.getElementById("metricDiscountPick").innerHTML = `${bestDiscount.ticker} <small class="text-purple">${bestDiscount.discountPct.toFixed(1)}%</small>`;
      document.getElementById("metricDiscountSub").innerText = `운용사 공시 단가 대비 할인 상태`;
    }

    const top1 = guru.holdings[0];
    if (top1) {
      document.getElementById("metricTopHolding").innerHTML = `${top1.ticker} <small>${top1.weight}%</small>`;
      document.getElementById("metricTopHoldingSub").innerText = `${top1.name} (${formatMoney(top1.value)})`;
    }
  } else {
    document.getElementById("metricTotalHoldings").innerText = `보유 종목 ${guru.holdings.length}개`;

    const buyPicks = guru.holdings.filter(h => h.action === "NEW" || h.action === "ADD");
    if (buyPicks.length > 0) {
      const topBuy = buyPicks[0];
      document.getElementById("metricTopBuy").innerHTML = `${topBuy.ticker} <small class="text-green">${topBuy.action === 'NEW' ? 'NEW' : '+' + topBuy.weight + '%'}</small>`;
      document.getElementById("metricTopBuySub").innerText = `${topBuy.name} (${formatMoney(topBuy.value)})`;
    } else {
      document.getElementById("metricTopBuy").innerText = "변동 없음";
      document.getElementById("metricTopBuySub").innerText = "신규/확대 매수 없음";
    }

    const discounts = guru.holdings
      .map(h => ({ ...h, discountPct: ((h.curPrice - h.estPrice) / h.estPrice) * 100 }))
      .sort((a, b) => a.discountPct - b.discountPct);
    const bestDiscount = discounts[0];
    if (bestDiscount && bestDiscount.discountPct < 0) {
      document.getElementById("metricDiscountPick").innerHTML = `${bestDiscount.ticker} <small class="text-purple">${bestDiscount.discountPct.toFixed(1)}%</small>`;
      document.getElementById("metricDiscountSub").innerText = `운용사 공시가 대비 할인`;
    }

    const top1 = guru.holdings[0];
    if (top1) {
      document.getElementById("metricTopHolding").innerHTML = `${top1.ticker} <small>${top1.weight}%</small>`;
      document.getElementById("metricTopHoldingSub").innerText = `${top1.name} (${formatMoney(top1.value)})`;
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

    if (state.activeFilter === "NEW") return item.action === "NEW";
    if (state.activeFilter === "ADD") return item.action === "ADD";
    if (state.activeFilter === "REDUCE") return item.action === "REDUCE";
    if (state.activeFilter === "DISCOUNT") return item.curPrice < item.estPrice;
    if (state.activeFilter === "CONVICTION") return item.weight >= 5.0;
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

    tr.innerHTML = `
      <td>
        <div class="ticker-cell">
          <div>
            <div class="ticker-symbol">${item.ticker}</div>
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
  discountTag.innerText = isDiscount ? `운용사 공시 단가 대비 ${discountPct}% 할인 상태` : `운용사 공시 단가 대비 +${discountPct}% 프리미엄`;
  discountTag.style.color = isDiscount ? "var(--color-purple)" : "var(--color-green)";

  document.getElementById("modalWeight").innerText = `${item.weight}%`;
  document.getElementById("modalVal").innerText = formatMoney(item.value);
  document.getElementById("modalShares").innerText = `${item.shares} 주`;
  document.getElementById("modalEstPrice").innerText = `$${item.estPrice.toFixed(2)}`;
  document.getElementById("modalInsightText").innerText = item.insight || "이 종목은 주요 운용사들의 장기적인 비즈니스 해자를 기반으로 포트폴리오에 편입되었습니다.";

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

  const btnSync = document.getElementById("btnSyncData");
  if (btnSync) {
    btnSync.onclick = async () => {
      btnSync.disabled = true;
      btnSync.classList.add("loading");
      const sText = document.getElementById("syncText");
      if (sText) sText.innerText = "13F 수집 및 실시간 주가 분석 중...";

      try {
        const res = await fetch("/api/sync", { method: "POST" });
        if (res.ok) {
          setTimeout(async () => {
            await loadRealSecData();
            loadGuruData(state.currentGuruKey);
            btnSync.disabled = false;
            btnSync.classList.remove("loading");
            if (sText) sText.innerText = "최신 13F 데이터 수집";
            alert("SEC 13F 공시 및 야후 파이낸스 실시간 주가 동기화가 완료되었습니다.");
          }, 3000);
        }
      } catch (err) {
        btnSync.disabled = false;
        btnSync.classList.remove("loading");
        if (sText) sText.innerText = "최신 13F 데이터 수집";
      }
    };
  }
}
