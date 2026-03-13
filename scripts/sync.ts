/**
 * 선수 데이터 싱크 스크립트
 *
 * 1. KBO 공식 사이트에서 선수 크롤링
 * 2. 결과를 /api/sync-players로 POST
 *
 * 사용법:
 *   npx tsx scripts/sync.ts                          # 로컬 dev 서버
 *   npx tsx scripts/sync.ts https://my-favorite-squad.raunplaymore.workers.dev  # 프로덕션
 */
import { crawlAllPlayers } from "./crawl-players";
import { crawlAllRosters } from "./crawl-roster";
import { crawlDefense } from "./crawl-defense";
import { crawlEntry } from "./crawl-entry";
import { readFileSync, writeFileSync, existsSync } from "fs";
import "dotenv/config";

const USE_ROSTER = process.argv.includes("--roster");
const USE_DEFENSE = process.argv.includes("--defense");
const USE_ENTRY = process.argv.includes("--entry");
const API_URL = process.argv.filter(a => !a.startsWith("--") && a !== process.argv[0] && a !== process.argv[1])[0] || "http://localhost:3000";
const SYNC_SECRET = process.env.SYNC_SECRET;

if (!SYNC_SECRET) {
  console.error("SYNC_SECRET이 .env에 설정되어 있지 않습니다.");
  process.exit(1);
}

async function main() {
  // 1. 크롤링 (--roster 플래그로 선수 조회 페이지 사용)
  // --cache: 이전 크롤링 결과 재사용
  const CACHE_FILE = "scripts/crawled-players.json";
  const USE_CACHE = process.argv.includes("--cache") && existsSync(CACHE_FILE);

  let players;
  if (USE_CACHE) {
    console.log(`캐시 파일 사용: ${CACHE_FILE}`);
    players = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
  } else {
    players = USE_ENTRY ? (await crawlEntry()).players
      : USE_DEFENSE ? await crawlDefense()
      : USE_ROSTER ? await crawlAllRosters()
      : await crawlAllPlayers();
    writeFileSync(CACHE_FILE, JSON.stringify(players, null, 2));
    console.log(`크롤링 결과 저장: ${CACHE_FILE} (${players.length}명)`);
  }

  // 2. API로 배치 전송 (D1 rate limit 방지)
  // --skip=N: 처음 N명 건너뛰기 (재개용)
  const BATCH_SIZE = 30;
  const skipArg = process.argv.find(a => a.startsWith("--skip="));
  const SKIP = skipArg ? parseInt(skipArg.split("=")[1]) : 0;
  const totals = { added: 0, updated: 0, deactivated: 0 };
  const MAX_RETRIES = 3;

  for (let i = SKIP; i < players.length; i += BATCH_SIZE) {
    const batch = players.slice(i, i + BATCH_SIZE);
    const isLast = i + BATCH_SIZE >= players.length;
    const url = `${API_URL}/api/sync-players`;

    console.log(`\n[${i + 1}-${Math.min(i + BATCH_SIZE, players.length)}/${players.length}] 전송 중...`);

    let success = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-sync-secret": SYNC_SECRET!,
          },
          body: JSON.stringify({
            players: batch,
            skipDeactivate: !isLast,
            ...(isLast ? { allKboPlayerIds: players.map((p: any) => p.kboPlayerId).filter(Boolean) } : {}),
          }),
        });

        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch {
          throw new Error(`Non-JSON response (${res.status}): ${text.substring(0, 200)}`);
        }

        if (res.ok) {
          totals.added += data.added || 0;
          totals.updated += data.updated || 0;
          totals.deactivated += data.deactivated || 0;
          console.log(`  추가: ${data.added}, 업데이트: ${data.updated}, 비활성: ${data.deactivated || 0}`);
          success = true;
          break;
        } else {
          throw new Error(`API error ${res.status}: ${JSON.stringify(data)}`);
        }
      } catch (e: any) {
        console.error(`  시도 ${attempt}/${MAX_RETRIES} 실패: ${e.message}`);
        if (attempt < MAX_RETRIES) {
          const wait = attempt * 3000;
          console.log(`  ${wait / 1000}초 후 재시도...`);
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    }

    if (!success) {
      console.error(`\n배치 실패! 재개하려면: npx tsx scripts/sync.ts --cache --skip=${i} ${API_URL}`);
      process.exit(1);
    }

    if (!isLast) await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(`\n싱크 완료: 총 ${players.length}명 — 추가 ${totals.added}, 업데이트 ${totals.updated}, 비활성 ${totals.deactivated}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
