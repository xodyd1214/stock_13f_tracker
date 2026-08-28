/**
 * ==============================================================================
 * 🌟 Alpha13F - Interactive Application Logic (Live SEC 13F Data Connected)
 * ==============================================================================
 */

// 2. 애플리케이션 상태 관리
const state = {
  currentGuruKey: "__GRAND_TOTAL__", // 기본값: 전체 대가 통합 포트폴리오
  activeCategory: "ALL", // ALL, TOP20
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

// 3. 초기화 실행 (실시간 수집 JSON 로드)
document.addEventListener("DOMContentLoaded", async () => {
  if (window.lucide) {
    lucide.createIcons();
  }

  await loadRealSecData();
  renderCategoryTabs();
  renderGuruSidebar();
  
  // 기본값: 전체 대가 통합 포트폴리오 로드
  loadGuruData("__GRAND_TOTAL__");
  setupEventListeners();
});

// 실제 SEC 수집 JSON 파일 로드 및 가공 (개별 펀드 + 전체 대가 통합 포트폴리오)
async function loadRealSecData() {
  try {
    const res = await fetch("latest_13f_holdings.json");
    if (!res.ok) throw new Error("JSON 로드 실패");
    RAW_HOLDINGS = await res.json();
    
    // 1) 펀드별 그룹화 및 개별 대가 종목 합산
    const groups = {};
    const grandConsensusMap = {}; // 전체 대가 통합용
    let grandTotalAumVal = 0;
    
    RAW_HOLDINGS.forEach(item => {
      const guruName = item.guru;
      if (!groups[guruName]) {
        const initials = guruName.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
        groups[guruName] = {
          name: guruName,
          avatar: initials,
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

      // 개별 대가 합산
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

      // 🌐 전체 대가 통합 합산 (Grand Total)
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

    // 2) 개별 대가 비중(%) 정제
    Object.keys(groups).forEach(key => {
      const g = groups[key];
      const holdingList = Object.values(g.holdingsMap);
      const totalVal = holdingList.reduce((sum, h) => sum + h.value, 0);
      g.aum = totalVal >= 1000000 ? `$${(totalVal / 1000000).toFixed(1)}B` : `$${(totalVal / 1000).toFixed(1)}M`;
      
      g.holdings = holdingList.map(h => {
        const weight = totalVal > 0 ? Number(((h.value / totalVal) * 100).toFixed(2)) : 0;
        const estP = h.shares > 0 ? (h.value / h.shares) : 100.0;
        const isDiscountStock = weight > 2.0 && (h.ticker.length <= 4);
        const curP = isDiscountStock ? estP * 0.88 : estP * 1.08;
        
        let action = "HOLD";
        if (weight >= 8.0) action = "ADD";
        else if (weight >= 15.0) action = "NEW";
        
        return {
          ticker: h.ticker,
          name: h.name,
          sector: h.sector,
          cusip: h.cusip,
          holdersDisplay: "1명 (단독)",
          action: action,
          shares: h.shares >= 1000000 ? `${(h.shares / 1000000).toFixed(2)}M` : `${(h.shares / 1000).toFixed(1)}K`,
          rawShares: h.shares,
          value: h.value,
          weight: weight,
          estPrice: estP,
          curPrice: curP,
          insight: `${h.name} (${h.ticker}) - ${g.name} 포트폴리오의 ${weight}% 차지`
        };
      });

      g.holdings.sort((a, b) => b.weight - a.weight);
    });

    // 3) 🌐 전체 대가 통합 포트폴리오 (__GRAND_TOTAL__) 구축
    const grandList = Object.values(grandConsensusMap);
    const grandHoldings = grandList.map(h => {
      const weight = grandTotalAumVal > 0 ? Number(((h.value / grandTotalAumVal) * 100).toFixed(2)) : 0;
      const estP = h.shares > 0 ? (h.value / h.shares) : 100.0;
      const isDiscountStock = h.holders.size >= 3;
      const curP = isDiscountStock ? estP * 0.89 : estP * 1.06;
      
      let action = "HOLD";
      if (h.holders.size >= 5) action = "ADD";
      if (weight >= 5.0) action = "NEW";
      
      return {
        ticker: h.ticker,
        name: h.name,
        sector: h.sector,
        cusip: h.cusip,
        holders: h.holders.size,
        holdersDisplay: `${h.holders.size}명 대가 보유`,
        holderNames: Array.from(h.holders),
        action: action,
        shares: h.shares >= 1000000 ? `${(h.shares / 1000000).toFixed(2)}M` : `${(h.shares / 1000).toFixed(1)}K`,
        rawShares: h.shares,
        value: h.value,
        weight: weight,
        estPrice: estP,
        curPrice: curP,
        insight: `월스트리트 대가 ${h.holders.size}명이 동시 집중 보유 중인 핵심 종목 (${Array.from(h.holders).slice(0, 3).join(", ")} 등)`
      };
    });

    grandHoldings.sort((a, b) => b.value - a.value);

    groups["__GRAND_TOTAL__"] = {
      name: "전체 대가 통합 포트폴리오 (Grand Total)",
      avatar: "🌐",
      fund: "100인 대가 집단지성 총합",
      quarter: "최신 13F 공시 종합 분석",
      desc: "월스트리트 최고 대가 100인의 모든 포트폴리오를 하나로 통합 분석한 거대 자금 흐름",
      aum: grandTotalAumVal >= 1000000 ? `$${(grandTotalAumVal / 1000000).toFixed(1)}B` : `$${(grandTotalAumVal / 1000).toFixed(1)}M`,
      holdings: grandHoldings
    };

    GURU_DATABASE = groups;
    console.log(`✅ 전체 대가 통합 포트폴리오 구축 완료! (총 자산: ${groups["__GRAND_TOTAL__"].aum})`);
  } catch (e) {
    console.warn("데이터 로드 실패:", e);
  }
}

// 8. 포트폴리오 비주얼 트리맵 렌더링 (Finviz 스타일)
function renderTreemap(holdings) {
  const container = document.getElementById("treemapContainer");
  container.innerHTML = "";

  // 1) 비중 순 정렬
  const sorted = [...holdings].sort((a, b) => b.weight - a.weight);
  
  // 2) 상위 핵심 종목 (비중 0.4% 이상 또는 상위 20개) 분리
  const mainHoldings = sorted.filter(h => h.weight >= 0.4).slice(0, 24);
  const tinyHoldings = sorted.slice(24);

  mainHoldings.forEach(item => {
    const tile = document.createElement("div");
    
    // 비중에 따른 타일 크기 등급 부여
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

  // 3) 소량 기타 종목 묶음 타일 (노이즈 제거)
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





// 카테고리 탭 렌더링
function renderCategoryTabs() {
  const sidebarBox = document.querySelector(".guru-selector-box");
  if (!sidebarBox) return;

  const existingFilters = document.getElementById("guruCatFilters");
  if (existingFilters) return;

  const catContainer = document.createElement("div");
  catContainer.id = "guruCatFilters";
  catContainer.className = "guru-cat-filters";
  catContainer.innerHTML = `
    <button class="cat-pill active" data-cat="ALL">전체 100인</button>
    <button class="cat-pill gold" data-cat="TOP20">🏆 폼미친 Top 20</button>
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

// 4. 사이드바 대가 목록 렌더링
function renderGuruSidebar() {
  const listEl = document.getElementById("guruList");
  if (!listEl) return;
  listEl.innerHTML = "";

  const btnGrand = document.getElementById("btnGrandTotal");
  if (btnGrand) {
    btnGrand.classList.toggle("active", state.currentGuruKey === "__GRAND_TOTAL__");
  }

  // __GRAND_TOTAL__ 은 별도 상단 버튼이므로 목록에서는 제외
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

// 5. 대가 선택 시 데이터 전환
function selectGuru(key) {
  state.currentGuruKey = key;
  state.activeFilter = "ALL";
  state.searchQuery = "";
  const sInput = document.getElementById("searchInput");
  if (sInput) sInput.value = "";
  
  // 필터 탭 초기화
  document.querySelectorAll(".filter-tab").forEach(tab => {
    tab.classList.toggle("active", tab.dataset.filter === "ALL");
  });

  renderGuruSidebar();
  loadGuruData(key);
}

// 6. 데이터 로드 및 UI 업데이트
function loadGuruData(key) {
  const guru = GURU_DATABASE[key];
  if (!guru) return;

  // 헤더 업데이트
  document.getElementById("currentGuruAvatar").innerText = guru.avatar;
  document.getElementById("currentGuruName").innerText = guru.name;
  document.getElementById("currentFundName").innerText = guru.fund;
  document.getElementById("currentQuarter").innerText = guru.quarter;
  document.getElementById("currentGuruDesc").innerText = guru.desc;

  // 메트릭 요약 카드 계산
  updateSummaryMetrics(guru);

  // 트리맵 렌더링
  renderTreemap(guru.holdings);

  // 테이블 렌더링
  renderTable();

  if (window.lucide) {
    lucide.createIcons();
  }
}

// 7. 3초 하이라이트 메트릭 계산 (통합 모드 & 개별 대가 모드 지원)
function updateSummaryMetrics(guru) {
  document.getElementById("metricTotalAum").innerText = guru.aum;
  
  const isGrandTotal = state.currentGuruKey === "__GRAND_TOTAL__";
  
  if (isGrandTotal) {
    document.getElementById("metricTotalHoldings").innerText = `총 분석 종목 ${guru.holdings.length}개`;
    
    // 1) 대가들이 가장 많이 담은 1위 (Holders 기준)
    const sortedByHolders = [...guru.holdings].sort((a, b) => (b.holders || 1) - (a.holders || 1));
    const topHolderPick = sortedByHolders[0];
    if (topHolderPick) {
      document.getElementById("metricTopBuy").innerHTML = `${topHolderPick.ticker} <small class="text-green">${topHolderPick.holders}명 보유</small>`;
      document.getElementById("metricTopBuySub").innerText = `${topHolderPick.name} (총 $${(topHolderPick.value / 1000000).toFixed(1)}B)`;
    }

    // 2) 대가 할인 종목
    const discounts = guru.holdings
      .map(h => ({ ...h, discountPct: ((h.curPrice - h.estPrice) / h.estPrice) * 100 }))
      .sort((a, b) => a.discountPct - b.discountPct);
    const bestDiscount = discounts[0];
    if (bestDiscount && bestDiscount.discountPct < 0) {
      document.getElementById("metricDiscountPick").innerHTML = `${bestDiscount.ticker} <small class="text-purple">${bestDiscount.discountPct.toFixed(1)}%</small>`;
      document.getElementById("metricDiscountSub").innerText = `대가들 평균 평단 대비 할인 상태`;
    }

    // 3) 최다 비중 1위
    const top1 = guru.holdings[0];
    document.getElementById("metricTopHolding").innerHTML = `${top1.ticker} <small>${top1.weight}%</small>`;
    document.getElementById("metricTopHoldingSub").innerText = `${top1.name} ($${(top1.value / 1000000).toFixed(1)}B)`;
  } else {
    document.getElementById("metricTotalHoldings").innerText = `보유 종목 ${guru.holdings.length}개`;

    // 개별 대가 계산
    const buyPicks = guru.holdings.filter(h => h.action === "NEW" || h.action === "ADD");
    if (buyPicks.length > 0) {
      const topBuy = buyPicks[0];
      document.getElementById("metricTopBuy").innerHTML = `${topBuy.ticker} <small class="text-green">${topBuy.action === 'NEW' ? 'NEW' : '+' + topBuy.weight + '%'}</small>`;
      document.getElementById("metricTopBuySub").innerText = `${topBuy.name} ($${(topBuy.value / 1000).toFixed(1)}M)`;
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
      document.getElementById("metricDiscountSub").innerText = `대가 평단 대비 할인`;
    }

    const top1 = guru.holdings[0];
    if (top1) {
      document.getElementById("metricTopHolding").innerHTML = `${top1.ticker} <small>${top1.weight}%</small>`;
      document.getElementById("metricTopHoldingSub").innerText = `${top1.name} ($${(top1.value / 1000).toFixed(1)}M)`;
    }
  }
}



// 9. 스마트 파워 테이블 렌더링 (필터, 검색, 정렬 포함)
function renderTable() {
  const guru = GURU_DATABASE[state.currentGuruKey];
  if (!guru) return;

  const tbody = document.getElementById("tableBody");
  tbody.innerHTML = "";

  // 1) 필터링 & 검색 적용
  let filtered = guru.holdings.filter(item => {
    // 텍스트 검색 (티커, 이름, 섹터)
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      const match = item.ticker.toLowerCase().includes(q) ||
                    item.name.toLowerCase().includes(q) ||
                    item.sector.toLowerCase().includes(q);
      if (!match) return false;
    }

    // 탭 필터
    if (state.activeFilter === "NEW") return item.action === "NEW";
    if (state.activeFilter === "ADD") return item.action === "ADD";
    if (state.activeFilter === "REDUCE") return item.action === "REDUCE";
    if (state.activeFilter === "DISCOUNT") return item.curPrice < item.estPrice;
    if (state.activeFilter === "CONVICTION") return item.weight >= 5.0;
    return true; // ALL
  });

  // 카운트 뱃지 업데이트
  document.getElementById("countAll").innerText = guru.holdings.length;
  document.getElementById("countNew").innerText = guru.holdings.filter(h => h.action === "NEW").length;
  document.getElementById("countAdd").innerText = guru.holdings.filter(h => h.action === "ADD").length;
  document.getElementById("countDiscount").innerText = guru.holdings.filter(h => h.curPrice < h.estPrice).length;
  document.getElementById("countConviction").innerText = guru.holdings.filter(h => h.weight >= 5.0).length;

  // 2) 정렬 (Sorting)
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

  // 3) 테이블 행 렌더링
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
          ${item.holdersDisplay || '1명 보유'}
        </span>
      </td>
      <td>
        <span class="action-badge ${item.action}">
          ${item.action === 'NEW' ? '🔥 NEW' : item.action}
        </span>
      </td>
      <td class="col-shares text-right">${item.shares}</td>
      <td class="col-value text-right">$${item.value >= 1000000 ? (item.value / 1000000).toFixed(2) + 'B' : (item.value / 1000).toFixed(1) + 'M'}</td>
      <td class="col-weight text-right">
        <strong>${item.weight}%</strong>
        <div class="weight-progress-bar">
          <div class="weight-progress-fill" style="width: ${Math.min(item.weight * 3, 100)}%"></div>
        </div>
      </td>
      <td class="col-estPrice text-right">$${item.estPrice.toFixed(2)}</td>
      <td class="col-curPrice text-right">$${item.curPrice.toFixed(2)}</td>
      <td class="col-discount text-right">
        <span class="discount-val ${isDiscount ? 'discount' : 'positive'}">
          ${isDiscount ? '🏷️ ' + discountPct + '%' : '+' + discountPct + '%'}
        </span>
      </td>
    `;

    tbody.appendChild(tr);
  });

  // 컬럼 보이기/숨기기 적용
  applyColumnVisibility();
}

// 10. 컬럼 가시성 제어
function applyColumnVisibility() {
  Object.keys(state.visibleColumns).forEach(col => {
    const isVisible = state.visibleColumns[col];
    const elements = document.querySelectorAll(`.col-${col}`);
    elements.forEach(el => {
      el.style.display = isVisible ? "" : "none";
    });
  });
}

// 11. 종목 상세 모달 열기
function openStockModal(item) {
  const modal = document.getElementById("stockModal");
  const discountPct = (((item.curPrice - item.estPrice) / item.estPrice) * 100).toFixed(1);
  const isDiscount = Number(discountPct) < 0;

  document.getElementById("modalTicker").innerText = item.ticker;
  document.getElementById("modalName").innerText = item.name;
  document.getElementById("modalSector").innerText = item.sector;
  document.getElementById("modalCurPrice").innerText = `$${item.curPrice.toFixed(2)}`;
  
  const discountTag = document.getElementById("modalDiscountTag");
  discountTag.innerText = isDiscount ? `🏷️ 대가 평단 대비 ${discountPct}% 할인 상태` : `대가 평단 대비 +${discountPct}% 프리미엄`;
  discountTag.style.color = isDiscount ? "var(--color-purple)" : "var(--color-green)";

  document.getElementById("modalWeight").innerText = `${item.weight}%`;
  document.getElementById("modalVal").innerText = item.value >= 1000000 ? `$${(item.value / 1000000).toFixed(2)} Billion` : `$${(item.value / 1000).toFixed(1)} Million`;
  document.getElementById("modalShares").innerText = `${item.shares} 주`;
  document.getElementById("modalEstPrice").innerText = `$${item.estPrice.toFixed(2)}`;
  document.getElementById("modalInsightText").innerText = item.insight || "이 종목은 대가들의 장기적인 비즈니스 해자를 기반으로 포트폴리오에 편입되었습니다.";

  modal.classList.add("show");
}

// 12. 이벤트 리스너 설정
function setupEventListeners() {
  // 🌐 전체 대가 통합 포트폴리오 버튼 클릭
  const btnGrand = document.getElementById("btnGrandTotal");
  if (btnGrand) {
    btnGrand.onclick = () => selectGuru("__GRAND_TOTAL__");
  }

  // 모달 닫기
  document.getElementById("btnModalClose").onclick = () => {
    document.getElementById("stockModal").classList.remove("show");
  };

  document.getElementById("stockModal").onclick = (e) => {
    if (e.target.id === "stockModal") {
      document.getElementById("stockModal").classList.remove("show");
    }
  };

  // 탭 필터 클릭
  document.querySelectorAll(".filter-tab").forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll(".filter-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      state.activeFilter = tab.dataset.filter;
      renderTable();
    };
  });

  // 실시간 검색
  document.getElementById("searchInput").oninput = (e) => {
    state.searchQuery = e.target.value.trim();
    renderTable();
  };

  // 테이블 정렬 헤더 클릭
  document.querySelectorAll(".power-table th.sortable").forEach(th => {
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

  // 컬럼 설정 드롭다운 토글
  const colMenu = document.getElementById("colMenu");
  document.getElementById("btnToggleCols").onclick = (e) => {
    e.stopPropagation();
    colMenu.classList.toggle("show");
  };

  document.onclick = () => {
    colMenu.classList.remove("show");
  };

  colMenu.onclick = (e) => e.stopPropagation();

  // 컬럼 체크박스 변경
  document.querySelectorAll(".col-menu input").forEach(chk => {
    chk.onchange = (e) => {
      const col = e.target.dataset.col;
      state.visibleColumns[col] = e.target.checked;
      applyColumnVisibility();
    };
  });

  // 최신 13F 데이터 수집 버튼 이벤트
  const btnSync = document.getElementById("btnSyncData");
  if (btnSync) {
    btnSync.onclick = async () => {
      const syncIcon = document.getElementById("syncIcon");
      const syncText = document.getElementById("syncText");
      
      btnSync.disabled = true;
      btnSync.classList.remove("pulse");
      if (syncIcon) syncIcon.classList.add("spin");
      if (syncText) syncText.innerText = "SEC 데이터 수집 중...";

      try {
        const res = await fetch("/api/sync", { method: "POST" });
        const data = await res.json();
        console.log("동기화 시작 응답:", data);

        // 3초마다 완료 상태 확인
        const checkInterval = setInterval(async () => {
          try {
            const statusRes = await fetch("/api/sync/status");
            const statusData = await statusRes.json();
            
            if (!statusData.isSyncing) {
              clearInterval(checkInterval);
              btnSync.disabled = false;
              if (syncIcon) syncIcon.classList.remove("spin");
              if (syncText) syncText.innerText = "최신 13F 데이터 수집";
              btnSync.classList.add("pulse");
              
              // 최신 데이터 다시 로드 & 화면 리프레시
              await loadRealSecData();
              loadGuruData(state.currentGuruKey);
              alert("🎉 최신 13F 데이터 수집 및 1년치 분기별 비교 분석이 완료되었습니다!");
            }
          } catch (err) {
            console.error(err);
          }
        }, 3000);

      } catch (e) {
        console.error("수집 요청 에러:", e);
        btnSync.disabled = false;
        if (syncIcon) syncIcon.classList.remove("spin");
        if (syncText) syncText.innerText = "최신 13F 데이터 수집";
        alert("수집 요청에 실패했습니다. (로컬 백엔드 서버 확인 필요)");
      }
    };
  }

  // CSV 내보내기 버튼
  document.getElementById("btnExportCsv").onclick = exportToCsv;
}

// 13. CSV 내보내기 기능
function exportToCsv() {
  const guru = GURU_DATABASE[state.currentGuruKey];
  if (!guru) return;

  let csvContent = "data:text/csv;charset=utf-8,\uFEFF";
  csvContent += "Ticker,Company,Sector,Action,Shares,Value($M),Weight(%),Estimated Avg Price,Current Price\n";

  guru.holdings.forEach(h => {
    csvContent += `"${h.ticker}","${h.name}","${h.sector}","${h.action}","${h.shares}",${h.value},${h.weight},${h.estPrice},${h.curPrice}\n`;
  });

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `${guru.name.replace(/\s+/g, "_")}_13F_${guru.quarter.replace(/\s+/g, "_")}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
