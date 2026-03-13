/**
 * 병합된 맞대결 데이터를 Cloudflare D1에 업로드
 *
 * 환경변수:
 *   CF_ACCOUNT_ID  — Cloudflare Account ID
 *   CF_API_TOKEN   — Cloudflare API Token (D1 write 권한)
 *   CF_DATABASE_ID — D1 Database ID
 *
 * 사용법:
 *   npx tsx scripts/upload-d1.ts                                    # 전체 교체 (DELETE + INSERT)
 *   npx tsx scripts/upload-d1.ts --upsert                           # UPSERT (기존 유지 + 업데이트)
 *   npx tsx scripts/upload-d1.ts --upsert --file scripts/daily-20260322.json   # 일일 업데이트
 *   npx tsx scripts/upload-d1.ts --validate                         # 데이터 검증 (레코드 수 + 샘플 무결성)
 *   npx tsx scripts/upload-d1.ts --count                            # 레코드 수만 출력
 *   npx tsx scripts/upload-d1.ts --dump backup.json                 # 전체 데이터 JSON 백업
 */
import { readFileSync, writeFileSync, existsSync } from "fs";

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const CF_DATABASE_ID = process.env.CF_DATABASE_ID;

if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !CF_DATABASE_ID) {
  console.error("Missing env: CF_ACCOUNT_ID, CF_API_TOKEN, CF_DATABASE_ID");
  process.exit(1);
}

const D1_API = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_DATABASE_ID}/query`;

interface MatchupResult {
  pitcherId: string;
  pitcherName: string;
  pitcherTeam: string;
  hitterId: string;
  hitterName: string;
  hitterTeam: string;
  stats: {
    avg: string;
    pa: number;
    ab: number;
    h: number;
    "2b": number;
    "3b": number;
    hr: number;
    rbi: number;
    bb: number;
    hbp: number;
    so: number;
    slg: string;
    obp: string;
    ops: string;
  } | null;
}

interface D1Response {
  success: boolean;
  result: { results: Record<string, unknown>[] }[];
}

async function execD1(sql: string, params: unknown[] = []): Promise<D1Response> {
  const res = await fetch(D1_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql, params }),
  });
  const data = (await res.json()) as D1Response;
  if (!res.ok || !data.success) {
    console.error("D1 error:", JSON.stringify(data, null, 2));
    throw new Error(`D1 query failed: ${res.status}`);
  }
  return data;
}

function getCliOption(flag: string, defaultVal: string): string {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return defaultVal;
  return process.argv[idx + 1];
}

// ─── --count: 레코드 수 출력 ───
async function runCount() {
  const data = await execD1("SELECT COUNT(*) as count FROM Matchup");
  const count = (data.result[0].results[0] as { count: number }).count;
  console.log(count);
  return count;
}

// ─── --validate: 데이터 검증 ───
async function runValidate() {
  const countData = await execD1("SELECT COUNT(*) as count FROM Matchup");
  const count = (countData.result[0].results[0] as { count: number }).count;

  const sampleData = await execD1(
    "SELECT * FROM Matchup ORDER BY RANDOM() LIMIT 10"
  );
  const samples = sampleData.result[0].results;

  let sampleErrors = 0;
  for (const row of samples) {
    const errors: string[] = [];
    if (!row.pitcherKboId) errors.push("pitcherKboId 누락");
    if (!row.hitterKboId) errors.push("hitterKboId 누락");
    if (typeof row.pa !== "number" || (row.pa as number) < 0)
      errors.push(`pa 이상: ${row.pa}`);
    if (typeof row.ab !== "number" || (row.ab as number) < 0)
      errors.push(`ab 이상: ${row.ab}`);
    if (typeof row.h !== "number" || (row.h as number) < 0)
      errors.push(`h 이상: ${row.h}`);

    if (errors.length > 0) {
      console.error(
        `  샘플 오류 [${row.pitcherName} vs ${row.hitterName}]: ${errors.join(", ")}`
      );
      sampleErrors++;
    }
  }

  const result = {
    totalCount: count,
    sampleSize: samples.length,
    sampleErrors,
    passed: count > 0 && sampleErrors === 0,
  };

  console.log(JSON.stringify(result));

  if (!result.passed) {
    console.error(`검증 실패: ${count}건, 샘플오류 ${sampleErrors}건`);
    process.exit(1);
  }

  console.error(`검증 통과: ${count}건, 샘플 ${samples.length}건 정상`);
}

// ─── --dump: 전체 데이터 백업 ───
async function runDump(outPath: string) {
  const PAGE = 1000;
  let offset = 0;
  const allRows: Record<string, unknown>[] = [];

  while (true) {
    const data = await execD1(
      `SELECT * FROM Matchup LIMIT ${PAGE} OFFSET ${offset}`
    );
    const rows = data.result[0].results;
    if (rows.length === 0) break;
    allRows.push(...rows);
    offset += rows.length;
    if (rows.length < PAGE) break;
  }

  writeFileSync(outPath, JSON.stringify(allRows, null, 2));
  console.log(`${allRows.length}건 백업 → ${outPath}`);
  return allRows.length;
}

// ─── 업로드 (기존 로직) ───
async function runUpload() {
  const isUpsert = process.argv.includes("--upsert");
  const resultsPath = getCliOption("--file", "data/matchup-merged.json");

  if (!existsSync(resultsPath)) {
    console.error(`${resultsPath} not found.`);
    process.exit(1);
  }

  const results: MatchupResult[] = JSON.parse(readFileSync(resultsPath, "utf-8"));
  const withStats = results.filter((r) => r.stats);
  console.log(`Total: ${results.length}, with stats: ${withStats.length}`);
  console.log(`Mode: ${isUpsert ? "UPSERT (기존 유지 + 업데이트)" : "REPLACE (전체 교체)"}`);

  // Ensure table exists
  await execD1(`
    CREATE TABLE IF NOT EXISTS Matchup (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pitcherKboId TEXT NOT NULL,
      pitcherName TEXT NOT NULL,
      pitcherTeam TEXT NOT NULL,
      hitterKboId TEXT NOT NULL,
      hitterName TEXT NOT NULL,
      hitterTeam TEXT NOT NULL,
      avg TEXT NOT NULL,
      pa INTEGER NOT NULL,
      ab INTEGER NOT NULL,
      h INTEGER NOT NULL,
      "2b" INTEGER NOT NULL DEFAULT 0,
      "3b" INTEGER NOT NULL DEFAULT 0,
      hr INTEGER NOT NULL DEFAULT 0,
      rbi INTEGER NOT NULL DEFAULT 0,
      bb INTEGER NOT NULL DEFAULT 0,
      hbp INTEGER NOT NULL DEFAULT 0,
      so INTEGER NOT NULL DEFAULT 0,
      slg TEXT,
      obp TEXT,
      ops TEXT,
      UNIQUE(pitcherKboId, hitterKboId)
    )
  `);
  console.log("Table ensured.");

  if (!isUpsert) {
    await execD1("DELETE FROM Matchup");
    console.log("Cleared existing data.");
  }

  // Batch insert (50 per batch)
  const BATCH = 50;
  let inserted = 0;

  for (let i = 0; i < withStats.length; i += BATCH) {
    const batch = withStats.slice(i, i + BATCH);
    const placeholders = batch
      .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .join(",\n");

    const params: unknown[] = [];
    for (const r of batch) {
      const s = r.stats!;
      params.push(
        r.pitcherId, r.pitcherName, r.pitcherTeam,
        r.hitterId, r.hitterName, r.hitterTeam,
        s.avg, s.pa, s.ab, s.h,
        s["2b"], s["3b"], s.hr, s.rbi,
        s.bb, s.hbp, s.so,
        s.slg, s.obp
      );
    }

    await execD1(
      `INSERT OR REPLACE INTO Matchup
        (pitcherKboId, pitcherName, pitcherTeam, hitterKboId, hitterName, hitterTeam,
         avg, pa, ab, h, "2b", "3b", hr, rbi, bb, hbp, so, slg, obp)
       VALUES ${placeholders}`,
      params
    );

    inserted += batch.length;
    if (inserted % 100 === 0 || inserted === withStats.length) {
      console.log(`  Inserted ${inserted}/${withStats.length}`);
    }
  }

  console.log(`\nDone! ${inserted} matchup records uploaded to D1.`);
}

// ─── 메인 라우팅 ───
async function main() {
  if (process.argv.includes("--count")) {
    await runCount();
  } else if (process.argv.includes("--validate")) {
    await runValidate();
  } else if (process.argv.includes("--dump")) {
    const outPath = getCliOption("--dump", "matchup-backup.json");
    await runDump(outPath);
  } else {
    await runUpload();
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
