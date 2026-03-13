# KBO Matchup Crawler

KBO 투수 vs 타자 맞대결 전적 크롤링 → Cloudflare D1 자동 업로드

## 구조

```
scripts/
  crawl-matchup.ts    — KBO 맞대결 크롤링 (팀별 병렬)
  upload-d1.ts        — 병합 결과 → D1 업로드
  crawled-players.json — 선수 데이터 (575명)
data/
  matchup-merged.json — 병합 결과 (artifact)
```

## GitHub Actions

매일 KST 00:00 자동 실행. 10팀 병렬 크롤링 → 병합 → D1 업로드.

### Secrets 설정

| Secret | 용도 |
|--------|------|
| `CF_ACCOUNT_ID` | Cloudflare Account ID |
| `CF_API_TOKEN` | Cloudflare API Token (D1 write) |
| `CF_DATABASE_ID` | D1 Database ID |
| `TELEGRAM_BOT_TOKEN` | (선택) 텔레그램 알림 |
| `TELEGRAM_CHAT_ID` | (선택) 텔레그램 알림 |

## 로컬 실행

```bash
npm install
npx tsx scripts/crawl-matchup.ts --sample        # 테스트
npx tsx scripts/crawl-matchup.ts --full           # 전체
npx tsx scripts/crawl-matchup.ts --merge          # 병합
```
