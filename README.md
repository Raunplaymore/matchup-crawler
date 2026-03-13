# DugOut Crawlers

KBO 선수 데이터 크롤링 모음 (덕아웃 서비스용)

## Scripts

| 명령어 | 설명 |
|--------|------|
| `npm run crawl:matchup` | 투수 vs 타자 맞대결 전적 (전체) |
| `npm run crawl:matchup:team -- LG` | 팀별 맞대결 크롤링 |
| `npm run crawl:players` | KBO 선수 기본 정보 |
| `npm run crawl:roster` | KBO 선수 검색 페이지 로스터 |
| `npm run crawl:defense` | 수비 기록 |
| `npm run crawl:register` | 1군 등록 현황 |
| `npm run sync` | 선수 데이터 → API 동기화 |
| `npm run sync:register` | 등록 현황 → API 동기화 |
| `npm run resolve:namu` | 나무위키 URL 해결 |
| `npm run upload:matchup` | 맞대결 데이터 → D1 업로드 |

## 환경변수 (.env)

```
SYNC_SECRET=...
API_URL=https://api.lineup.prmtwiki.com
```
