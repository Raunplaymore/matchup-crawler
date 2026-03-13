/**
 * 병합된 맞대결 데이터를 Cloudflare D1에 업로드
 *
 * 환경변수:
 *   CF_ACCOUNT_ID  — Cloudflare Account ID
 *   CF_API_TOKEN   — Cloudflare API Token (D1 write 권한)
 *   CF_DATABASE_ID — D1 Database ID
 *
 * 사용법:
 *   npx tsx scripts/upload-d1.ts
 */
import { readFileSync, existsSync } from "fs";

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

async function execD1(sql: string, params: unknown[] = []) {
  const res = await fetch(D1_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql, params }),
  });
  const data = await res.json();
  if (!res.ok || !(data as { success: boolean }).success) {
    console.error("D1 error:", JSON.stringify(data, null, 2));
    throw new Error(`D1 query failed: ${res.status}`);
  }
  return data;
}

async function main() {
  // Load merged results
  const resultsPath = "data/matchup-merged.json";
  if (!existsSync(resultsPath)) {
    console.error(`${resultsPath} not found. Run merge first.`);
    process.exit(1);
  }

  const results: MatchupResult[] = JSON.parse(readFileSync(resultsPath, "utf-8"));
  const withStats = results.filter((r) => r.stats);
  console.log(`Total: ${results.length}, with stats: ${withStats.length}`);

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

  // Clear existing data
  await execD1("DELETE FROM Matchup");
  console.log("Cleared existing data.");

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

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
