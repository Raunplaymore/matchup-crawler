/**
 * 1군 등록 현황 싱크 스크립트
 *
 * KBO 공식 사이트에서 1군 등록 선수를 크롤링하고 DB에 반영.
 * 시즌 중 Daily로 실행하여 registered 필드를 최신 상태로 유지.
 *
 * 사용법:
 *   npx tsx scripts/sync-register.ts                          # 로컬 (최신 날짜)
 *   npx tsx scripts/sync-register.ts 20260401                 # 특정 날짜
 *   npx tsx scripts/sync-register.ts https://...workers.dev   # 프로덕션
 *   npx tsx scripts/sync-register.ts 20260401 https://...     # 날짜 + 프로덕션
 */
import { crawlRegisterAll } from "./crawl-register";
import "dotenv/config";

const args = process.argv.slice(2);
const dateArg = args.find(a => /^\d{8}$/.test(a));
const urlArg = args.find(a => a.startsWith("http"));
const API_URL = urlArg || "http://localhost:3000";
const SYNC_SECRET = process.env.SYNC_SECRET;

if (!SYNC_SECRET) {
  console.error("SYNC_SECRET이 .env에 설정되어 있지 않습니다.");
  process.exit(1);
}

async function main() {
  console.log("=== 1군 등록 현황 싱크 ===\n");

  const { date, players } = await crawlRegisterAll(dateArg);
  console.log(`\n날짜: ${date}, 등록 선수: ${players.length}명`);

  if (players.length === 0) {
    console.log("등록 선수가 없습니다 (비시즌일 수 있음).");
    return;
  }

  console.log(`\n${API_URL}/sync/register 로 전송 중...`);

  const res = await fetch(`${API_URL}/sync/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-sync-secret": SYNC_SECRET!,
    },
    body: JSON.stringify({ players }),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    console.error(`Non-JSON response (${res.status}): ${text.substring(0, 300)}`);
    process.exit(1);
  }

  if (res.ok) {
    console.log("\n싱크 완료:", data);
    if (data.unmatchedList?.length > 0) {
      console.log("\n매칭 실패 선수:");
      for (const name of data.unmatchedList) {
        console.log(`  - ${name}`);
      }
    }
  } else {
    console.error("\n싱크 실패:", res.status, data);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
