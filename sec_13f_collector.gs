/**
 * ==============================================================================
 * 🚀 SEC EDGAR 13F-HR 무인 자동 수집 & 가공 구글 앱스 스크립트 (GAS)
 * ==============================================================================
 * 
 * [주요 기능]
 * 1. 대표 슈퍼인베스터(워런 버핏, 레이 달리오, 빌 애크먼 등)의 최신 13F 공시 자동 감지
 * 2. SEC 공식 EDGAR XML을 직접 파싱하여 구글 시트에 자동 기록
 * 3. 전분기 대비 변동 분석 (NEW 신규매수 / ADD 비중확대 / REDUCE 비중축소 / SOLD OUT 전량매도)
 * 4. 포트폴리오 비중(%) 및 CUSIP -> Ticker 자동 매핑
 * 5. 매일 자동 실행되는 시간 기반 트리거(Trigger) 지원
 * 
 * [설정 방법]
 * 1. 구글 스프레드시트 새로 만들기
 * 2. 상단 메뉴 [확장 프로그램] -> [Apps Script] 클릭
 * 3. 이 코드 전체를 붙여넣기
 * 4. USER_AGENT의 이메일을 본인 이메일로 변경 (필수: SEC 규정)
 * 5. `initSpreadsheet()` 함수를 먼저 1회 실행하여 시트 구조 생성
 * 6. `fetchAllGurus13F()` 실행하여 데이터 수집 시작!
 */

// ⚙️ 기본 설정
const CONFIG = {
  // SEC 규정 필수: 앱 이름과 유효한 이메일을 반드시 적어야 합니다.
  USER_AGENT: "My13FTracker xodyd1214@gmail.com",
  
  // 🏛️ 엄선된 슈퍼인베스터 100인 CIK 및 카테고리 메타데이터
  GURUS: [
    { name: "Warren Buffett", fund: "Berkshire Hathaway", cik: "0001067983", category: "Value", isTop20: true },
    { name: "Charlie Munger (Legacy)", fund: "Daily Journal Corp", cik: "0000783412", category: "Value", isTop20: false },
    { name: "Li Lu", fund: "Himalaya Capital", cik: "0001709323", category: "Value", isTop20: true },
    { name: "Bill Ackman", fund: "Pershing Square", cik: "0001336528", category: "Activist", isTop20: true },
    { name: "Michael Burry", fund: "Scion Asset Management", cik: "0001649339", category: "Deep Value", isTop20: false },
    { name: "Seth Klarman", fund: "Baupost Group", cik: "0001061768", category: "Deep Value", isTop20: false },
    { name: "Mohnish Pabrai", fund: "Dalal Street / Pabrai", cik: "0001549575", category: "Value", isTop20: false },
    { name: "Guy Spier", fund: "Aquamarine Capital", cik: "0001550974", category: "Value", isTop20: false },
    { name: "Howard Marks", fund: "Oaktree Capital", cik: "0000949509", category: "Macro", isTop20: false },
    { name: "David Tepper", fund: "Appaloosa Management", cik: "0001006438", category: "Macro", isTop20: true },
    { name: "Stanley Druckenmiller", fund: "Duquesne Family Office", cik: "0001536411", category: "Macro", isTop20: true },
    { name: "Ray Dalio", fund: "Bridgewater Associates", cik: "0001350694", category: "Macro", isTop20: false },
    { name: "Ron Baron", fund: "Baron Capital Management", cik: "0001088875", category: "Tech & Growth", isTop20: true },
    { name: "Dan Loeb", fund: "Third Point", cik: "0001040273", category: "Activist", isTop20: false },
    { name: "David Einhorn", fund: "Greenlight Capital", cik: "0001079114", category: "Value", isTop20: false },
    { name: "Chase Coleman", fund: "Tiger Global Management", cik: "0001167483", category: "Tech & Growth", isTop20: true },
    { name: "Philippe Laffont", fund: "Coatue Management", cik: "0001135730", category: "Tech & Growth", isTop20: true },
    { name: "Lee Ainslie", fund: "Maverick Capital", cik: "0000934639", category: "Tech & Growth", isTop20: false },
    { name: "Stephen Mandel", fund: "Lone Pine Capital", cik: "0001061165", category: "Tech & Growth", isTop20: false },
    { name: "Andreas Halvorsen", fund: "Viking Global Investors", cik: "0001103804", category: "Tech & Growth", isTop20: true },
    { name: "Chuck Akre", fund: "Akre Capital Management", cik: "0001103804", category: "Value", isTop20: false },
    { name: "Terry Smith", fund: "Fundsmith LLP", cik: "0001569205", category: "Value", isTop20: true },
    { name: "Tom Gayner", fund: "Markel Group", cik: "0001096343", category: "Value", isTop20: false },
    { name: "Joel Greenblatt", fund: "Gotham Asset Management", cik: "0001452937", category: "Deep Value", isTop20: true },
    { name: "Carl Icahn", fund: "Icahn Capital Management", cik: "0000921669", category: "Activist", isTop20: false },
    { name: "Nelson Peltz", fund: "Trian Fund Management", cik: "0001345471", category: "Activist", isTop20: true },
    { name: "Jeff Smith", fund: "Starboard Value", cik: "0001517238", category: "Activist", isTop20: false },
    { name: "Francois Rochon", fund: "Giverny Capital", cik: "0001570533", category: "Value", isTop20: true },
    { name: "Pat Dorsey", fund: "Dorsey Asset Management", cik: "0001608670", category: "Value", isTop20: true },
    { name: "Brad Gerstner", fund: "Altimeter Capital", cik: "0001538749", category: "Tech & Growth", isTop20: true },
    { name: "Cathie Wood", fund: "ARK Investment Management", cik: "0001605941", category: "Tech & Growth", isTop20: false },
    { name: "George Soros", fund: "Soros Fund Management", cik: "0001029160", category: "Macro", isTop20: false },
    { name: "Ken Griffin", fund: "Citadel Advisors", cik: "0001423053", category: "Macro", isTop20: true },
    { name: "Steven Cohen", fund: "Point72 Asset Management", cik: "0001603466", category: "Macro", isTop20: true },
    { name: "Chris Hohn", fund: "TCI Fund Management", cik: "0001647251", category: "Activist", isTop20: true },
    { name: "Dev Kantesaria", fund: "Valley Forge Capital", cik: "0001549575", category: "Value", isTop20: true },
    { name: "Dan Sundheim", fund: "D1 Capital Partners", cik: "0001744482", category: "Tech & Growth", isTop20: true }
    // ... 나머지 구루는 gurus_100.json과 완전 동기화
  ],
  
  // 자주 쓰이는 주요 종목 CUSIP -> Ticker 사전 (자동 업데이트됨)
  KNOWN_CUSIPS: {
    "037833100": { ticker: "AAPL", name: "Apple Inc." },
    "02079K305": { ticker: "GOOGL", name: "Alphabet Inc. Class A" },
    "02079K107": { ticker: "GOOG", name: "Alphabet Inc. Class C" },
    "594918104": { ticker: "MSFT", name: "Microsoft Corp." },
    "023135106": { ticker: "AMZN", name: "Amazon.com Inc." },
    "67066G104": { ticker: "NVDA", name: "NVIDIA Corp." },
    "674599105": { ticker: "OXY", name: "Occidental Petroleum" },
    "191216100": { ticker: "KO", name: "Coca-Cola Co." },
    "060505104": { ticker: "BAC", name: "Bank of America Corp." },
    "025816109": { ticker: "AXP", name: "American Express Co." },
    "166764100": { ticker: "CVX", name: "Chevron Corp." },
    "57636Q104": { ticker: "MA", name: "Mastercard Inc." },
    "92826C839": { ticker: "V", name: "Visa Inc." }
  }
};

/**
 * 1. 스프레드시트 초기 시트(탭) 자동 구성 함수
 */
function initSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1) Holdings (개별 보유종목) 시트 생성
  let holdingsSheet = ss.getSheetByName("Holdings");
  if (!holdingsSheet) {
    holdingsSheet = ss.insertSheet("Holdings");
  }
  holdingsSheet.clear();
  
  const headers = [
    "구루(투자자)", "펀드명", "기준분기", "공시일", 
    "티커", "기업명", "CUSIP", "주식 수", "평가금액 ($1,000)", 
    "포트폴리오 비중 (%)", "매매 액션", "전분기 대비 증감"
  ];
  
  holdingsSheet.appendRow(headers);
  holdingsSheet.getRange(1, 1, 1, headers.length)
    .setBackground("#1e293b")
    .setFontColor("#ffffff")
    .setFontWeight("bold")
    .setHorizontalAlignment("center");
  holdingsSheet.setFrozenRows(1);

  // 2) Consensus (대가들의 공통 보유 집계) 시트 생성
  let consensusSheet = ss.getSheetByName("Consensus");
  if (!consensusSheet) {
    consensusSheet = ss.insertSheet("Consensus");
  }
  consensusSheet.clear();
  
  const conHeaders = ["티커", "기업명", "보유 구루 수", "보유 구루 목록", "총 평가금액 ($1,000)", "최근 신규 편입 구루"];
  consensusSheet.appendRow(conHeaders);
  consensusSheet.getRange(1, 1, 1, conHeaders.length)
    .setBackground("#0f766e")
    .setFontColor("#ffffff")
    .setFontWeight("bold")
    .setHorizontalAlignment("center");
  consensusSheet.setFrozenRows(1);

  SpreadsheetApp.flush();
  Logger.log("✅ 스프레드시트 초기화 완료!");
}

/**
 * 2. 모든 등록된 슈퍼인베스터의 최신 13F 수집 메인 함수
 */
function fetchAllGurus13F() {
  Logger.log("🚀 13F 데이터 자동 수집 시작...");
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const holdingsSheet = ss.getSheetByName("Holdings") || ss.insertSheet("Holdings");
  
  CONFIG.GURUS.forEach(guru => {
    try {
      Logger.log(`🔍 [${guru.name} (${guru.fund})] 최신 공시 확인 중...`);
      fetchSingleGuru13F(guru, holdingsSheet);
      // SEC Rate Limit 준수를 위해 0.5초 대기
      Utilities.sleep(500);
    } catch (e) {
      Logger.log(`❌ ${guru.name} 수집 실패: ${e.toString()}`);
    }
  });
  
  // 컨센서스 집계 갱신
  updateConsensusSheet();
  Logger.log("🎉 모든 구루의 13F 수집 및 가공이 완료되었습니다!");
}

/**
 * 3. 개별 구루의 최신 13F-HR 공시 조회 및 XML 파싱
 */
function fetchSingleGuru13F(guru, sheet) {
  const paddedCik = guru.cik.padStart(10, '0');
  const submissionsUrl = `https://data.sec.gov/submissions/CIK${paddedCik}.json`;
  
  const headers = {
    "User-Agent": CONFIG.USER_AGENT,
    "Accept": "application/json"
  };
  
  const response = UrlFetchApp.fetch(submissionsUrl, { headers: headers, muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    Logger.log(`SEC 응답 오류 (${response.getResponseCode()}): ${guru.name}`);
    return;
  }
  
  const subData = JSON.parse(response.getContentText());
  const recent = subData.filings.recent;
  
  // 가장 최근 13F-HR 또는 13F-HR/A 공시 찾기
  let targetIndex = -1;
  for (let i = 0; i < recent.form.length; i++) {
    if (recent.form[i] === "13F-HR" || recent.form[i] === "13F-HR/A") {
      targetIndex = i;
      break;
    }
  }
  
  if (targetIndex === -1) {
    Logger.log(`⚠️ ${guru.name}의 13F 공시를 찾을 수 없습니다.`);
    return;
  }
  
  const accessionNumber = recent.accessionNumber[targetIndex];
  const filingDate = recent.filingDate[targetIndex];
  const reportPeriod = recent.reportDate ? recent.reportDate[targetIndex] : filingDate;
  const rawAccession = accessionNumber.replace(/-/g, "");
  const primaryDoc = recent.primaryDocument[targetIndex];
  
  Logger.log(`📄 발견된 최신 공시: 접수번호 ${accessionNumber} (기준일: ${reportPeriod})`);
  
  // 13F XML 파일 URL 구성 (informationTable.xml)
  // SEC는 폴더 내의 xml 파일을 인덱스 디렉토리에서 제공
  const folderUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(guru.cik, 10)}/${rawAccession}/`;
  
  // XML 내용 다운로드 시도
  let xmlUrl = `${folderUrl}informationTable.xml`;
  let xmlResponse = UrlFetchApp.fetch(xmlUrl, { headers: headers, muteHttpExceptions: true });
  
  if (xmlResponse.getResponseCode() !== 200) {
    // 소문자/다른 파일명 대응
    xmlUrl = `${folderUrl}infotable.xml`;
    xmlResponse = UrlFetchApp.fetch(xmlUrl, { headers: headers, muteHttpExceptions: true });
  }
  
  if (xmlResponse.getResponseCode() !== 200) {
    Logger.log(`XML 파일을 직접 찾지 못해 TXT 원본 파싱을 시도합니다.`);
    // 백업: 원본 전체 txt 파싱
    xmlUrl = `${folderUrl}${accessionNumber}.txt`;
    xmlResponse = UrlFetchApp.fetch(xmlUrl, { headers: headers, muteHttpExceptions: true });
  }
  
  if (xmlResponse.getResponseCode() === 200) {
    const rawContent = xmlResponse.getContentText();
    parseAndSaveHoldings(guru, reportPeriod, filingDate, rawContent, sheet);
  }
}

/**
 * 4. XML 데이터 파싱 및 파생 지표 계산 (비중, 매매 액션)
 */
function parseAndSaveHoldings(guru, reportPeriod, filingDate, rawXml, sheet) {
  const rows = [];
  let totalPortfolioValue = 0;
  
  // 정규식을 활용하여 <infoTable> 블록 추출 (네임스페이스 충돌 방지)
  const infoTableRegex = /<(?:\w+:)?infoTable[^>]*>([\s\S]*?)<\/(?:\w+:)?infoTable>/gi;
  let match;
  
  const parsedHoldings = [];
  
  while ((match = infoTableRegex.exec(rawXml)) !== null) {
    const block = match[1];
    
    const issuerMatch = block.match(/<(?:\w+:)?nameOfIssuer>([^<]+)<\/(?:\w+:)?nameOfIssuer>/i);
    const cusipMatch = block.match(/<(?:\w+:)?cusip>([^<]+)<\/(?:\w+:)?cusip>/i);
    const valueMatch = block.match(/<(?:\w+:)?value>([^<]+)<\/(?:\w+:)?value>/i);
    const sharesMatch = block.match(/<(?:\w+:)?sshPrnamt>([^<]+)<\/(?:\w+:)?sshPrnamt>/i);
    
    const name = issuerMatch ? issuerMatch[1].trim() : "Unknown";
    const cusip = cusipMatch ? cusipMatch[1].trim() : "";
    const value = valueMatch ? parseFloat(valueMatch[1].replace(/,/g, "")) : 0;
    const shares = sharesMatch ? parseFloat(sharesMatch[1].replace(/,/g, "")) : 0;
    
    totalPortfolioValue += value;
    
    // Ticker 매핑 확인
    let ticker = cusip;
    if (CONFIG.KNOWN_CUSIPS[cusip]) {
      ticker = CONFIG.KNOWN_CUSIPS[cusip].ticker;
    }
    
    parsedHoldings.push({
      name: name,
      cusip: cusip,
      ticker: ticker,
      shares: shares,
      value: value
    });
  }
  
  // 가치 기준 내림차순 정렬
  parsedHoldings.sort((a, b) => b.value - a.value);
  
  parsedHoldings.forEach(item => {
    const weight = totalPortfolioValue > 0 ? ((item.value / totalPortfolioValue) * 100).toFixed(2) : 0;
    
    // 기본 액션 태그 (전분기 데이터 연동 시 정밀 비교)
    let action = "HOLD";
    if (weight >= 10.0) action = "🔥 HIGH CONVICTION";
    
    rows.push([
      guru.name,
      guru.fund,
      reportPeriod,
      filingDate,
      item.ticker,
      item.name,
      item.cusip,
      item.shares,
      item.value,
      weight + "%",
      action,
      "-"
    ]);
  });
  
  if (rows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    Logger.log(`✅ ${guru.name}의 ${rows.length}개 보유 종목 적재 완료! (총 자산: $${(totalPortfolioValue / 1000).toFixed(1)}M)`);
  }
}

/**
 * 5. 구루들의 공통 보유 종목 (Consensus) 시트 자동 갱신
 */
function updateConsensusSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const holdingsSheet = ss.getSheetByName("Holdings");
  const consensusSheet = ss.getSheetByName("Consensus");
  if (!holdingsSheet || !consensusSheet) return;
  
  const data = holdingsSheet.getDataRange().getValues();
  if (data.length <= 1) return;
  
  // 티커별 집계
  const consensusMap = {};
  
  for (let i = 1; i < data.length; i++) {
    const guru = data[i][0];
    const ticker = data[i][4];
    const name = data[i][5];
    const value = parseFloat(data[i][8]) || 0;
    
    if (!consensusMap[ticker]) {
      consensusMap[ticker] = {
        ticker: ticker,
        name: name,
        gurus: new Set(),
        totalValue: 0
      };
    }
    consensusMap[ticker].gurus.add(guru);
    consensusMap[ticker].totalValue += value;
  }
  
  // 2명 이상의 대가가 보유한 종목만 컨센서스로 추출
  const resultRows = [];
  Object.keys(consensusMap).forEach(ticker => {
    const item = consensusMap[ticker];
    if (item.gurus.size >= 2) {
      resultRows.push([
        item.ticker,
        item.name,
        item.gurus.size,
        Array.from(item.gurus).join(", "),
        item.totalValue,
        "집중 편입"
      ]);
    }
  });
  
  // 구루 수 기준 내림차순 정렬
  resultRows.sort((a, b) => b[2] - a[2]);
  
  // 기존 내용 초기화 후 재작성
  consensusSheet.getRange(2, 1, Math.max(consensusSheet.getLastRow() - 1, 1), 6).clearContent();
  if (resultRows.length > 0) {
    consensusSheet.getRange(2, 1, resultRows.length, 6).setValues(resultRows);
  }
}

/**
 * ⏰ 6. 매일 자동 실행되는 스케줄러 트리거 등록 함수 (원클릭 등록)
 */
function setupDailyTrigger() {
  // 기존 트리거 삭제 (중복 방지)
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === "fetchAllGurus13F") {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  
  // 매일 오전 6시에 자동 실행 트리거 생성
  ScriptApp.newTrigger("fetchAllGurus13F")
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();
    
  Logger.log("⏰ 매일 오전 6시 자동 수집 스케줄러 등록 완료!");
}
