# 🚀 Alpha13F - 미국 SEC 공시 & 거시경제 스마트 투자 분석 대시보드

![License](https://img.shields.io/badge/license-MIT-green.svg)
![Python](https://img.shields.io/badge/Python-3.9+-blue.svg)
![Frontend](https://img.shields.io/badge/Frontend-Vanilla%20JS%20%7C%20CSS3-orange.svg)
![Design](https://img.shields.io/badge/Design-Spotify%20Dark%20Theme-1ed760.svg)

> **Alpha13F**는 미국 증권거래위원회(SEC)의 공식 공시 데이터(Form 13F, Form 4, Schedule 13D/13G)와 거시경제(Macro) 핵심 지표를 통합하여, 월가 큰손들의 포트폴리오와 자금 흐름을 한눈에 파악할 수 있는 스마트 투자 분석 플랫폼입니다.

---

## 🌟 주요 핵심 기능

### 1. 📊 Form 13F: 100대 기관 운용사 포트폴리오 분석
- **월가 거인들의 포트폴리오 추적**: 워렌 버핏(버크셔 해서웨이), 브리지워터, 사이언 등 미국 1억 달러 이상 운용 자격을 갖춘 100개 주요 기관의 분기별 포트폴리오를 완벽 분석
- **통합 분석 (Grand Total)**: 100개 운용사의 보유 종목을 하나로 합산하여 시장 전체의 자금 쏠림을 추적
- **비주얼 트리맵 & 섹터 분석**: 산업군별 비중 분포와 매매 액션(신규 매수 NEW, 비중 확대 ADD, 유지 HOLD, 비중 축소 REDUCE)을 직관적인 컬러 트리맵으로 시각화
- **시세 관측시각 확인**: 검증된 종목 식별자에 한해 Yahoo Finance USD 시세를 표시합니다. 24시간을 넘거나 시각·통화가 미확인인 시세는 과거 관측값으로 분리합니다. 주식분할 등 자본변동 조정을 검증하기 전에는 분기말 대비 등락률과 할인 순위를 표시하지 않습니다.
- **스마트 파워 테이블**: 멀티 필터링(신규/추가매수, 할인종목, 5%+ 집중투자), 실시간 검색, 동적 컬럼 설정 및 CSV 내보내기 지원
- **종목 상세 분석 모달**: 분기별 비중 변천 히스토리 및 해당 종목을 보유한 운용사 명단·비중 대조

### 2. 👔 Form 4: 실시간 내부자 거래(Insider Trading) 추적
- **105개 주요 상장사 추적**: 주요 테크주 및 상장 기업 내부자들의 지분 변동 모니터링
- **스마트 매수 시그널 포착**: CEO/경영진의 장내 직접 매수(Code P)와 매도(Code S)를 구분하여 핵심 내부자 신호 감지
- **상세 거래 명세 & SEC 원문**: 거래 단가, 수량, 거래 대금, 거래 후 잔여 지분율 및 SEC 공식 원문 공시 다이렉트 링크 제공

### 3. 🎯 Schedule 13D / 13G: 행동주의 & 대량 지분 공시
- **지분 5% 이상 대량 취득 추적**: 주요 투자자 및 헤지펀드의 대량 지분 변동 실시간 모니터링
- **행동주의 vs 단순 투자 분류**: 경영 참여 및 주주 제안 목적의 행동주의(13D)와 단순 패시브 투자(13G)를 자동 분류

### 4. 🧭 Macro Compass: 거시경제 & FOMC 캘린더
- **핵심 4대 지표 요약**: 연준 기준금리(Fed Funds Target / EFFR / SOFR), 미국 CPI 소비자물가(YoY), 실업률, 10Y-3M 장단기 금리차
- **정책 기준선(Benchmark) 팩트 대조**: 물가 목표(2.0%), 공식 중립금리(2.90%), 침체 역전선(0.00%p)과 실시간 수치를 1:1 대조
- **금리 시계열 차트 & 스프레드 궤적**: 미국 국채 만기별(3M/5Y/10Y) 시계열 라인 차트와 뉴욕 연준 기준 경기침체 선행 신호 궤적 제공
- **주요 발표 일정 캘린더**: FOMC 회의, CPI, 고용지표(NFP) 등 주요 이벤트 D-Day 카운트다운

### 5. 🎨 Spotify-Inspired 다크 테마 & 개인화
- **Content-First Darkness**: 깊이감 있는 차콜 다크 서페이스(`rgb(18, 18, 18)`)와 Spotify Green(`rgb(30, 215, 96)`) 악센트로 데이터 가독성 극대화
- **개인화 기능**: Firebase Auth 기반 구글 로그인 지원, 관심 운용사 및 관심 기업 즐겨찾기 묶어보기

---

## 🛠️ 기술 스택

| 영역 | 기술 / 라이브러리 |
| :--- | :--- |
| **Frontend** | Vanilla JavaScript (ES6+), HTML5, CSS3, SVG Charts |
| **Backend** | Python 3, Built-in `http.server`, Multi-threading Sync Controller |
| **Data Scraping** | Python (`requests`, `urllib`, `xml.etree.ElementTree`) |
| **Data Sources** | SEC EDGAR API, Yahoo Finance API, FRED / BLS 거시경제 데이터 |
| **Auth & Cloud** | Google Firebase Authentication, Firestore |

---

## 📁 프로젝트 구조

```plaintext
stock_13f_tracker/
├── index.html                   # 메인 대시보드 인터페이스
├── app.js                       # 프론트엔드 핵심 로직 및 인터랙션 컨트롤러
├── style.css                    # Spotify 스타일 다크 테마 CSS
├── server.py                    # 로컬 웹 서버 및 데이터 온디맨드 API 컨트롤러
│
├── collector_1year.py           # SEC 13F 기관 포트폴리오 데이터 수집기
├── sec_insider_collector.py     # SEC Form 4 내부자 거래 데이터 수집기
├── sec_13d_collector.py         # SEC Schedule 13D/13G 대량 보유 데이터 수집기
├── macro_collector.py           # 거시경제 지표 및 FOMC 캘린더 수집기
├── price_fetcher.py             # 야후 파이낸스 실시간 시세 연동기
│
├── gurus_100.json               # 100대 운용사 메타데이터 정의
├── ticker_map.json              # 상장 기업 티커 매핑 데이터
├── latest_13f_holdings.json     # 최신 13F 포트폴리오 데이터셋
├── latest_form4_insiders.json   # 최신 Form 4 내부자 거래 데이터셋
├── latest_13d_filings.json      # 최신 13D/13G 공시 데이터셋
└── latest_macro_indicators.json # 최신 거시경제 지표 데이터셋
```

---

## 💻 로컬 개발 및 실행 방법

### 1. 저장소 복제 (Clone)
```bash
git clone https://github.com/xodyd1214/stock_13f_tracker.git
cd stock_13f_tracker
```

### 2. Python 가상환경 생성 및 패키지 설치
```bash
# 가상환경 생성
python3 -m venv .venv

# 가상환경 활성화 (macOS / Linux)
source .venv/bin/activate

# 가상환경 활성화 (Windows)
# .venv\Scripts\activate

# 필요 패키지 설치
pip install requests
```

### 3. 로컬 서버 실행
```bash
python3 server.py
```
서버 실행 후 브라우저에서 **`http://localhost:8080`**으로 접속합니다.

### 4. 최신 데이터 갱신 (선택 사항)
웹 화면의 동기화 버튼을 누르거나 터미널에서 직접 수집 스크립트를 실행할 수 있습니다:
```bash
# 13F 포트폴리오 수집
python3 collector_1year.py

# 실시간 주가 갱신
python3 price_fetcher.py

# 거시경제 지표 갱신
python3 macro_collector.py
```

---

## 📜 라이선스
This project is open-sourced under the MIT License.



## 데이터 안전성 및 검증 범위

- 공시 평가단가는 SEC 공시 평가액을 주식 수로 나눈 값이며 실제 매입단가가 아닙니다. 현재 수집 경로에 검증된 자본변동 이력이 없으므로, 주식분할·역분할·합병 등을 조정한 가격 비교는 지원하지 않습니다. 해당 비율, 하락 종목 필터 결과와 추천은 보류합니다.
- 최근 시세 표시는 관측시각 기준 24시간, 최대 미래 오차 5분, USD 통화가 확인된 경우에만 허용합니다. 주말이나 휴일에 24시간이 지난 종가는 과거 관측값으로 표시합니다. 이는 거래소 영업일 달력에 기반한 실시간 보증이 아닙니다.
- 새 응답의 수집 시각이 최근이어도 시장 관측시각이 더 오래되면 기존 시세를 덮어쓰지 않습니다. 동일 관측시각의 상충 가격 및 미래 시각은 거부합니다. 기존 캐시에 잘못된 미래 시각이 있으면 정상 시세로 복구할 수 있습니다.
- 기관 공동 보유와 평가액 순위는 매수 합의 또는 이번 분기 매수 증가를 뜻하지 않습니다. 미분류 섹터는 Other로 남깁니다.
- 13F 일정은 분기말 이후 45일, 주말 및 해당 기간에 겹치는 Presidents Day를 보정하고 일반 EDGAR 마감인 미 동부시간 오후 5:30을 사용합니다. 특별 SEC 휴무, 기밀 취급 또는 지연 제출을 예측하지 않습니다. [SEC Form 13F FAQ](https://www.sec.gov/rules-regulations/staff-guidance/frequently-asked-questions-about-form-13f), [SEC filing-date guidance](https://www.sec.gov/submit-filings/filer-support-resources/how-do-i-guides/determine-status-my-filing).

오프라인 회귀 검사: `python3 -m unittest discover -s tests -v`, `node --test tests/frontend.test.cjs`, `node --check app.js`.
