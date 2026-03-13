/**
 * KBO 투수 vs 타자 맞대결 전적 크롤링 스크립트
 *
 * 소스: https://www.koreabaseball.com/Record/Etc/HitVsPit.aspx
 *
 * 플로우 (한 건당 4단계):
 *   1. GET 초기 페이지 → VIEWSTATE + 쿠키 확보
 *   2. POST 투수팀 선택 → ddlPitcherPlayer 옵션 로드
 *   3. POST 타자팀 선택 → ddlHitterPlayer 옵션 로드
 *   4. POST 검색 → 맞대결 결과 테이블 파싱
 *
 * 사용법:
 *   npx tsx scripts/crawl-matchup.ts --sample                # 샘플 (투수3 x 타자3)
 *   npx tsx scripts/crawl-matchup.ts --full                  # 전체 (일일 7500건 제한)
 *   npx tsx scripts/crawl-matchup.ts --full --pitcher-team LT  # 특정 투수팀만
 *   npx tsx scripts/crawl-matchup.ts --resume                # 이어서 (캐시 기반)
 *   npx tsx scripts/crawl-matchup.ts --full --limit 3000     # 커스텀 일일 제한
 *   npx tsx scripts/crawl-matchup.ts --full --fresh          # 캐시 초기화 + 전체
 *   npx tsx scripts/crawl-matchup.ts --merge                 # 팀별 캐시 병합
 */
import * as cheerio from "cheerio";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { robustFetch, robustFetchWithCookies } from "./lib/http";

// ─── 설정 ───
const BASE = "https://www.koreabaseball.com";
const URL = `${BASE}/Record/Etc/HitVsPit.aspx`;

// 텔레그램 알림 (환경변수로만 설정)
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

// ─── CLI 옵션 파서 ───
function getCliOption(flag: string, defaultVal: string): string {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return defaultVal;
  return process.argv[idx + 1];
}

// KBO 팀코드 매핑 (crawled-players.json의 팀명 → HitVsPit 셀렉트박스 value)
const TEAM_CODE: Record<string, string> = {
  LG: "LG", 한화: "HH", SSG: "SK", 삼성: "SS",
  NC: "NC", KT: "KT", 롯데: "LT", KIA: "HT",
  두산: "OB", 키움: "WO",
};

// ASP.NET 컨트롤 prefix
const CTL = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents";

// ─── 타입 ───
interface MatchupResult {
  pitcherId: string;
  pitcherName: string;
  pitcherTeam: string;
  hitterId: string;
  hitterName: string;
  hitterTeam: string;
  stats: {
    avg: string;    // 타율
    pa: number;     // 타석
    ab: number;     // 타수
    h: number;      // 안타
    "2b": number;   // 2루타
    "3b": number;   // 3루타
    hr: number;     // 홈런
    rbi: number;    // 타점
    bb: number;     // 볼넷
    hbp: number;    // 사구
    so: number;     // 삼진
    slg: string;    // 장타율
    obp: string;    // 출루율
    ops: string;    // OPS
  } | null;         // null = "기록이 없습니다"
}

interface CrawlCache {
  completed: string[];  // "pitcherId:hitterId" 완료 키
  results: MatchupResult[];
  lastUpdated: string;
}

// ─── 팀코드 역매핑 (코드 → 팀명) ───
const CODE_TO_TEAM: Record<string, string> = Object.fromEntries(
  Object.entries(TEAM_CODE).map(([name, code]) => [code, name])
);

// ─── 캐시 ───
const PITCHER_TEAM_FILTER = getCliOption("--pitcher-team", "");

function getCachePath(): string {
  return PITCHER_TEAM_FILTER
    ? `scripts/matchup-cache-${PITCHER_TEAM_FILTER}.json`
    : "scripts/matchup-cache.json";
}

function getResultPath(): string {
  return PITCHER_TEAM_FILTER
    ? `scripts/matchup-results-${PITCHER_TEAM_FILTER}.json`
    : "scripts/matchup-results.json";
}

function loadCache(): CrawlCache {
  if (process.argv.includes("--fresh")) return { completed: [], results: [], lastUpdated: "" };
  const cachePath = getCachePath();
  if (!existsSync(cachePath)) return { completed: [], results: [], lastUpdated: "" };
  try {
    return JSON.parse(readFileSync(cachePath, "utf-8"));
  } catch {
    return { completed: [], results: [], lastUpdated: "" };
  }
}

function saveCache(cache: CrawlCache) {
  cache.lastUpdated = new Date().toISOString();
  writeFileSync(getCachePath(), JSON.stringify(cache, null, 2));
}

// ─── ASP.NET 유틸 ───
function extractHiddenFields(html: string): Record<string, string> {
  const $ = cheerio.load(html);
  const fields: Record<string, string> = {};
  $("input[type=hidden]").each((_, el) => {
    const name = $(el).attr("name");
    const val = $(el).val() as string;
    if (name) fields[name] = val || "";
  });
  return fields;
}

function buildPostBody(
  hiddenFields: Record<string, string>,
  overrides: Record<string, string>
): URLSearchParams {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(hiddenFields)) {
    body.set(k, v);
  }
  for (const [k, v] of Object.entries(overrides)) {
    body.set(k, v);
  }
  return body;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── 텔레그램 알림 ───
async function sendTelegram(text: string) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text,
        parse_mode: "HTML",
      }),
    });
  } catch {
    // 알림 실패는 무시 — 크롤링 자체에 영향 주지 않음
  }
}

// ─── 결과 파싱 ───
function parseMatchupTable(html: string): MatchupResult["stats"] | null {
  const $ = cheerio.load(html);

  // "기록이 없습니다" 체크
  if (html.includes("기록이 없습니다")) return null;

  const rows = $("table.tData tbody tr");
  if (rows.length === 0) return null;

  // 첫 번째 행 (통산 또는 단일 시즌)
  const cells = $(rows[0]).find("td");
  if (cells.length < 14) return null;

  const text = (i: number) => $(cells[i]).text().trim();
  const num = (i: number) => parseInt(text(i)) || 0;

  const stats = {
    avg: text(0),
    pa: num(1),
    ab: num(2),
    h: num(3),
    "2b": num(4),
    "3b": num(5),
    hr: num(6),
    rbi: num(7),
    bb: num(8),
    hbp: num(9),
    so: num(10),
    slg: text(11),
    obp: text(12),
    ops: text(13),
  };

  // 무결성 검증
  const issues = validateStats(stats);
  if (issues.length > 0) {
    console.warn(`    ⚠️ 데이터 이상: ${issues.join(", ")}`);
  }

  return stats;
}

// ─── 통계 무결성 검증 ───
function validateStats(s: NonNullable<MatchupResult["stats"]>): string[] {
  const issues: string[] = [];

  // 타수 <= 타석
  if (s.ab > s.pa) issues.push(`AB(${s.ab})>PA(${s.pa})`);
  // 안타 <= 타수
  if (s.h > s.ab) issues.push(`H(${s.h})>AB(${s.ab})`);
  // 장타 <= 안타
  if (s["2b"] + s["3b"] + s.hr > s.h) issues.push(`2B+3B+HR(${s["2b"]+s["3b"]+s.hr})>H(${s.h})`);
  // 삼진 <= 타수
  if (s.so > s.ab) issues.push(`SO(${s.so})>AB(${s.ab})`);
  // 타석 = 타수 + 볼넷 + 사구 + (기타: 희생플라이 등이라 완전일치는 아님)
  // 하지만 AB + BB + HBP > PA 는 이상
  if (s.ab + s.bb + s.hbp > s.pa) issues.push(`AB+BB+HBP(${s.ab+s.bb+s.hbp})>PA(${s.pa})`);
  // 타율 범위 (문자열이라 파싱)
  const avgNum = parseFloat(s.avg);
  if (!isNaN(avgNum) && (avgNum < 0 || avgNum > 1)) issues.push(`AVG(${s.avg}) 범위 초과`);
  // PA가 0인데 다른 값이 있으면 이상
  if (s.pa === 0 && (s.h > 0 || s.ab > 0)) issues.push(`PA=0인데 기록 있음`);

  return issues;
}

// ─── 크롤링 검증 리포트 ───
function printVerificationReport(results: MatchupResult[]) {
  const withStats = results.filter(r => r.stats);
  const noStats = results.filter(r => !r.stats);

  let invalidCount = 0;
  let totalPA = 0;
  let totalH = 0;
  let totalHR = 0;

  for (const r of withStats) {
    if (!r.stats) continue;
    const issues = validateStats(r.stats);
    if (issues.length > 0) invalidCount++;
    totalPA += r.stats.pa;
    totalH += r.stats.h;
    totalHR += r.stats.hr;
  }

  // 팀별 분포
  const pitcherTeams = new Map<string, number>();
  const hitterTeams = new Map<string, number>();
  for (const r of results) {
    pitcherTeams.set(r.pitcherTeam, (pitcherTeams.get(r.pitcherTeam) || 0) + 1);
    hitterTeams.set(r.hitterTeam, (hitterTeams.get(r.hitterTeam) || 0) + 1);
  }

  console.log("\n=== 검증 리포트 ===");
  console.log(`총 결과: ${results.length}건 (기록있음: ${withStats.length}, 없음: ${noStats.length})`);
  console.log(`무결성 이상: ${invalidCount}건 (${(invalidCount/Math.max(withStats.length,1)*100).toFixed(1)}%)`);
  console.log(`합계: ${totalPA} 타석, ${totalH} 안타, ${totalHR} 홈런`);
  console.log(`투수팀 분포: ${Array.from(pitcherTeams.entries()).map(([t,c]) => `${t}:${c}`).join(" ")}`);
  console.log(`타자팀 분포: ${Array.from(hitterTeams.entries()).map(([t,c]) => `${t}:${c}`).join(" ")}`);
}

// ─── 세션 클래스 ───
class KBOSession {
  private cookies = "";
  private hiddenFields: Record<string, string> = {};
  private currentPitcherTeam = "";
  private currentHitterTeam = "";

  // Step 1: 초기 페이지 로드
  async init(): Promise<boolean> {
    try {
      const { text: html, cookies } = await robustFetchWithCookies(URL, {
        timeoutMs: 30000,
        retries: 3,
      });
      this.cookies = cookies;
      this.hiddenFields = extractHiddenFields(html);
      this.currentPitcherTeam = "";
      this.currentHitterTeam = "";
      return true;
    } catch (e) {
      console.error("  세션 초기화 실패:", e);
      return false;
    }
  }

  // Step 2: 투수팀 선택 (팀이 바뀔 때만)
  async selectPitcherTeam(teamCode: string): Promise<boolean> {
    if (this.currentPitcherTeam === teamCode) return true;

    try {
      const body = buildPostBody(this.hiddenFields, {
        __EVENTTARGET: `${CTL}$ddlPitcherTeam`,
        __EVENTARGUMENT: "",
        [`${CTL}$ddlPitcherTeam`]: teamCode,
        [`${CTL}$ddlHitterTeam`]: this.currentHitterTeam || "",
      });

      const res = await robustFetch(URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: this.cookies,
          Referer: URL,
        },
        body: body.toString(),
        timeoutMs: 30000,
        retries: 3,
      });

      const html = await res.text();
      this.hiddenFields = extractHiddenFields(html);
      this.currentPitcherTeam = teamCode;
      return html.includes("ddlPitcherPlayer");
    } catch (e) {
      console.error(`  투수팀 ${teamCode} 선택 실패:`, e);
      return false;
    }
  }

  // Step 3: 타자팀 선택 (팀이 바뀔 때만)
  async selectHitterTeam(teamCode: string): Promise<boolean> {
    if (this.currentHitterTeam === teamCode) return true;

    try {
      const body = buildPostBody(this.hiddenFields, {
        __EVENTTARGET: `${CTL}$ddlHitterTeam`,
        __EVENTARGUMENT: "",
        [`${CTL}$ddlPitcherTeam`]: this.currentPitcherTeam,
        [`${CTL}$ddlHitterTeam`]: teamCode,
      });

      const res = await robustFetch(URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: this.cookies,
          Referer: URL,
        },
        body: body.toString(),
        timeoutMs: 30000,
        retries: 3,
      });

      const html = await res.text();
      this.hiddenFields = extractHiddenFields(html);
      this.currentHitterTeam = teamCode;
      return html.includes("ddlHitterPlayer");
    } catch (e) {
      console.error(`  타자팀 ${teamCode} 선택 실패:`, e);
      return false;
    }
  }

  // Step 4: 검색 실행
  async search(pitcherId: string, hitterId: string): Promise<MatchupResult["stats"] | null | "error"> {
    try {
      const body = buildPostBody(this.hiddenFields, {
        __EVENTTARGET: "",
        __EVENTARGUMENT: "",
        [`${CTL}$ddlPitcherTeam`]: this.currentPitcherTeam,
        [`${CTL}$ddlPitcherPlayer`]: pitcherId,
        [`${CTL}$ddlHitterTeam`]: this.currentHitterTeam,
        [`${CTL}$ddlHitterPlayer`]: hitterId,
        [`${CTL}$btnSearch`]: "검색",
      });

      // ScriptManager 추가 (AsyncPostback)
      body.set(
        `${CTL}$ScriptManager1`,
        `${CTL}$udpRecord|${CTL}$btnSearch`
      );
      body.set("__ASYNCPOST", "true");

      const res = await robustFetch(URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: this.cookies,
          Referer: URL,
        },
        body: body.toString(),
        timeoutMs: 30000,
        retries: 3,
      });

      const html = await res.text();

      // AsyncPostback 응답에서 hiddenFields 업데이트
      // 응답이 |로 구분된 UpdatePanel 형식일 수 있음
      if (html.includes("__VIEWSTATE")) {
        // 전체 HTML이면 직접 파싱
        if (html.includes("<html")) {
          this.hiddenFields = extractHiddenFields(html);
        } else {
          // AsyncPostback 응답에서 VIEWSTATE 추출
          const vsMatch = html.match(/__VIEWSTATE\|([^|]*)\|/);
          if (vsMatch) this.hiddenFields["__VIEWSTATE"] = vsMatch[1];
          const evMatch = html.match(/__EVENTVALIDATION\|([^|]*)\|/);
          if (evMatch) this.hiddenFields["__EVENTVALIDATION"] = evMatch[1];
        }
      }

      return parseMatchupTable(html);
    } catch (e) {
      console.error(`  검색 실패 (pitcher=${pitcherId}, hitter=${hitterId}):`, e);
      return "error";
    }
  }
}

// ─── 선수 데이터 로드 ───
interface PlayerInfo {
  name: string;
  team: string;
  teamCode: string;
  kboPlayerId: string;
  position: string;
}

function loadPlayers(): { pitchers: PlayerInfo[]; hitters: PlayerInfo[] } {
  const raw = JSON.parse(readFileSync("scripts/crawled-players.json", "utf-8"));
  const pitchers: PlayerInfo[] = [];
  const hitters: PlayerInfo[] = [];

  for (const p of raw) {
    if (!p.kboPlayerId || !TEAM_CODE[p.team]) continue;
    const info: PlayerInfo = {
      name: p.name,
      team: p.team,
      teamCode: TEAM_CODE[p.team],
      kboPlayerId: p.kboPlayerId,
      position: p.position,
    };
    if (p.position === "투수") pitchers.push(info);
    else hitters.push(info);
  }

  return { pitchers, hitters };
}

// ─── 샘플 크롤링 ───
async function runSample() {
  const { pitchers, hitters } = loadPlayers();

  // 서로 다른 팀에서 투수 3명, 타자 3명 선택
  const samplePitchers = [
    pitchers.find(p => p.team === "한화"),
    pitchers.find(p => p.team === "LG"),
    pitchers.find(p => p.team === "KIA"),
  ].filter(Boolean) as PlayerInfo[];

  const sampleHitters = [
    hitters.find(p => p.team === "두산"),
    hitters.find(p => p.team === "삼성"),
    hitters.find(p => p.team === "키움"),
  ].filter(Boolean) as PlayerInfo[];

  console.log("=== 샘플 크롤링 시작 ===\n");
  console.log(`투수 ${samplePitchers.length}명:`, samplePitchers.map(p => `${p.name}(${p.team})`).join(", "));
  console.log(`타자 ${sampleHitters.length}명:`, sampleHitters.map(p => `${p.name}(${p.team})`).join(", "));
  console.log(`조합: ${samplePitchers.length * sampleHitters.length}건\n`);

  const session = new KBOSession();
  if (!await session.init()) {
    console.error("세션 초기화 실패!");
    return;
  }
  console.log("세션 초기화 성공\n");

  const results: MatchupResult[] = [];
  let success = 0;
  let noRecord = 0;
  let errors = 0;

  for (const pitcher of samplePitchers) {
    // 투수팀 선택
    console.log(`[투수팀: ${pitcher.team} (${pitcher.teamCode})]`);
    if (!await session.selectPitcherTeam(pitcher.teamCode)) {
      console.error(`  투수팀 선택 실패 → 세션 재초기화`);
      if (!await session.init()) { errors++; continue; }
      if (!await session.selectPitcherTeam(pitcher.teamCode)) { errors++; continue; }
    }
    await sleep(1000);

    for (const hitter of sampleHitters) {
      // 타자팀 선택
      if (!await session.selectHitterTeam(hitter.teamCode)) {
        console.error(`  타자팀 선택 실패 → 세션 재초기화`);
        if (!await session.init()) { errors++; continue; }
        if (!await session.selectPitcherTeam(pitcher.teamCode)) { errors++; continue; }
        if (!await session.selectHitterTeam(hitter.teamCode)) { errors++; continue; }
      }
      await sleep(1000);

      // 검색
      console.log(`  ${pitcher.name} vs ${hitter.name} ...`);
      const stats = await session.search(pitcher.kboPlayerId, hitter.kboPlayerId);
      await sleep(1500);

      if (stats === "error") {
        console.log(`    ❌ 에러`);
        errors++;
        continue;
      }

      const result: MatchupResult = {
        pitcherId: pitcher.kboPlayerId,
        pitcherName: pitcher.name,
        pitcherTeam: pitcher.team,
        hitterId: hitter.kboPlayerId,
        hitterName: hitter.name,
        hitterTeam: hitter.team,
        stats,
      };
      results.push(result);

      if (stats) {
        console.log(`    ✅ ${stats.avg} (${stats.pa}타석, ${stats.h}안타, ${stats.hr}HR, ${stats.so}삼진)`);
        success++;
      } else {
        console.log(`    ⚪ 기록 없음`);
        noRecord++;
      }
    }
  }

  // 결과 저장
  const samplePath = "scripts/matchup-sample.json";
  writeFileSync(samplePath, JSON.stringify(results, null, 2));

  console.log(`\n=== 샘플 크롤링 완료 ===`);
  console.log(`성공: ${success}건, 기록없음: ${noRecord}건, 에러: ${errors}건`);
  console.log(`결과: ${samplePath}`);

  // 검증 리포트
  printVerificationReport(results);

  return results;
}

const DAILY_LIMIT = parseInt(getCliOption("--limit", "7500"));
const REQUEST_DELAY = parseInt(getCliOption("--delay", "3000")); // ms
const SESSION_REFRESH = parseInt(getCliOption("--refresh", "40"));

// ─── 전체/팀 크롤링 ───
async function runFull() {
  const { pitchers: allPitchers, hitters } = loadPlayers();
  const cache = loadCache();
  const completedSet = new Set(cache.completed);

  // --pitcher-team 필터 적용
  const pitchers = PITCHER_TEAM_FILTER
    ? allPitchers.filter(p => p.teamCode === PITCHER_TEAM_FILTER)
    : allPitchers;

  if (PITCHER_TEAM_FILTER && pitchers.length === 0) {
    console.error(`투수팀 코드 "${PITCHER_TEAM_FILTER}" 에 해당하는 투수가 없습니다.`);
    console.error(`유효한 코드: ${Object.values(TEAM_CODE).join(", ")}`);
    process.exit(1);
  }

  // 팀별로 그룹화 — 같은 투수팀끼리 묶어서 세션 재사용
  const pitchersByTeam = new Map<string, PlayerInfo[]>();
  for (const p of pitchers) {
    const arr = pitchersByTeam.get(p.teamCode) || [];
    arr.push(p);
    pitchersByTeam.set(p.teamCode, arr);
  }

  const hittersByTeam = new Map<string, PlayerInfo[]>();
  for (const h of hitters) {
    const arr = hittersByTeam.get(h.teamCode) || [];
    arr.push(h);
    hittersByTeam.set(h.teamCode, arr);
  }

  // 같은 팀 매치업 제외한 총 조합 수 계산
  let totalPairs = 0;
  for (const [ptCode, teamP] of pitchersByTeam) {
    for (const [htCode, teamH] of hittersByTeam) {
      if (ptCode === htCode) continue; // 같은 팀 스킵
      totalPairs += teamP.length * teamH.length;
    }
  }

  const remaining = totalPairs - completedSet.size;
  const todayLimit = Math.min(DAILY_LIMIT, remaining);
  const estimatedHours = (todayLimit * (REQUEST_DELAY / 1000)) / 3600;

  const teamLabel = PITCHER_TEAM_FILTER
    ? ` [${CODE_TO_TEAM[PITCHER_TEAM_FILTER] || PITCHER_TEAM_FILTER}]`
    : "";
  console.log(`=== 맞대결 크롤링${teamLabel} ===\n`);
  console.log(`투수: ${pitchers.length}명 (${pitchersByTeam.size}팀)`);
  console.log(`타자: ${hitters.length}명 (${hittersByTeam.size}팀, 같은 팀 제외)`);
  console.log(`전체: ${totalPairs}건, 완료: ${completedSet.size}건, 남은: ${remaining}건`);
  console.log(`오늘 목표: ${todayLimit}건 (간격: ${REQUEST_DELAY/1000}초, 예상: ~${estimatedHours.toFixed(1)}시간)`);
  console.log(`세션 리프레시: ${SESSION_REFRESH}건마다\n`);

  await sendTelegram(
    `⚾ <b>맞대결 크롤링 시작${teamLabel}</b>\n` +
    `남은: ${remaining}건 / 전체: ${totalPairs}건\n` +
    `오늘 목표: ${todayLimit}건 (~${estimatedHours.toFixed(1)}시간)`
  );

  if (remaining === 0) {
    console.log("모든 조합이 완료되었습니다!");
    writeFileSync(getResultPath(), JSON.stringify(cache.results, null, 2));
    return;
  }

  const session = new KBOSession();
  let sessionAge = 0;

  let todayCount = 0; // 오늘 처리 건수
  let success = 0;
  let noRecord = 0;
  let errors = 0;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 10;
  const startTime = Date.now();

  // 투수팀 → 타자팀 순서로 순회 (세션 재사용 최대화)
  for (const [pitcherTeamCode, teamPitchers] of pitchersByTeam) {
    if (todayCount >= todayLimit) break;

    for (const [hitterTeamCode, teamHitters] of hittersByTeam) {
      if (todayCount >= todayLimit) break;

      // 같은 팀 매치업 스킵 (투수는 자기 팀 타자를 상대하지 않음)
      if (pitcherTeamCode === hitterTeamCode) continue;

      // 이 팀 조합에서 미완료 건 확인
      const pendingPairs: { pitcher: PlayerInfo; hitter: PlayerInfo }[] = [];
      for (const pitcher of teamPitchers) {
        for (const hitter of teamHitters) {
          const key = `${pitcher.kboPlayerId}:${hitter.kboPlayerId}`;
          if (!completedSet.has(key)) {
            pendingPairs.push({ pitcher, hitter });
          }
        }
      }

      if (pendingPairs.length === 0) continue;

      const pitcherTeamName = teamPitchers[0].team;
      const hitterTeamName = teamHitters[0].team;
      console.log(`\n[${pitcherTeamName} 투수 vs ${hitterTeamName} 타자] ${pendingPairs.length}건`);

      // 세션 초기화/리프레시
      if (sessionAge === 0 || sessionAge >= SESSION_REFRESH) {
        console.log(`  세션 ${sessionAge === 0 ? "초기화" : "리프레시"}...`);
        if (!await session.init()) {
          console.error("  세션 초기화 실패! 30초 대기 후 재시도...");
          await sleep(30000);
          if (!await session.init()) {
            console.error("  재시도 실패. 다음 팀 조합으로 건너뜀.");
            continue;
          }
        }
        sessionAge = 0;
      }

      // 팀 선택
      if (!await session.selectPitcherTeam(pitcherTeamCode)) {
        await session.init();
        if (!await session.selectPitcherTeam(pitcherTeamCode)) continue;
        sessionAge = 0;
      }
      await sleep(1000);

      if (!await session.selectHitterTeam(hitterTeamCode)) {
        await session.init();
        if (!await session.selectPitcherTeam(pitcherTeamCode)) continue;
        if (!await session.selectHitterTeam(hitterTeamCode)) continue;
        sessionAge = 0;
      }
      await sleep(1000);

      // 각 매치업 검색
      for (const { pitcher, hitter } of pendingPairs) {
        if (todayCount >= todayLimit) {
          console.log(`\n  일일 한도 도달 (${todayLimit}건) → 중단`);
          break;
        }

        const key = `${pitcher.kboPlayerId}:${hitter.kboPlayerId}`;

        const stats = await session.search(pitcher.kboPlayerId, hitter.kboPlayerId);
        sessionAge++;
        todayCount++;
        await sleep(REQUEST_DELAY);

        if (stats === "error") {
          errors++;
          consecutiveErrors++;
          console.log(`  ❌ ${pitcher.name} vs ${hitter.name} — 에러 (연속 ${consecutiveErrors})`);

          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            console.log(`  연속 에러 ${MAX_CONSECUTIVE_ERRORS}회 → 세션 리프레시 후 60초 대기`);
            await sendTelegram(
              `🚨 <b>연속 에러 ${MAX_CONSECUTIVE_ERRORS}회</b>\n` +
              `진행: ${completedSet.size}/${totalPairs}\n60초 대기 후 재시도`
            );
            saveCache(cache);
            await sleep(60000);
            if (!await session.init()) break;
            if (!await session.selectPitcherTeam(pitcherTeamCode)) break;
            if (!await session.selectHitterTeam(hitterTeamCode)) break;
            sessionAge = 0;
            consecutiveErrors = 0;
          }
          continue;
        }

        consecutiveErrors = 0;
        const result: MatchupResult = {
          pitcherId: pitcher.kboPlayerId,
          pitcherName: pitcher.name,
          pitcherTeam: pitcher.team,
          hitterId: hitter.kboPlayerId,
          hitterName: hitter.name,
          hitterTeam: hitter.team,
          stats,
        };

        cache.results.push(result);
        cache.completed.push(key);
        completedSet.add(key);

        if (stats) {
          success++;
        } else {
          noRecord++;
        }

        // 100건마다 진행률 로그 + 캐시 저장
        if (todayCount % 100 === 0) {
          saveCache(cache);
          const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
          const pct = ((completedSet.size / totalPairs) * 100).toFixed(1);
          const rate = (todayCount / ((Date.now() - startTime) / 1000)).toFixed(2);
          const eta = ((todayLimit - todayCount) / parseFloat(rate) / 60).toFixed(0);
          console.log(
            `  [${todayCount}/${todayLimit}] 누적: ${completedSet.size}/${totalPairs} (${pct}%) | ` +
            `성공:${success} 없음:${noRecord} 에러:${errors} | ${elapsed}분 경과 | ~${eta}분 남음`
          );
        }
      }
    }
  }

  // 최종 저장
  saveCache(cache);
  writeFileSync(getResultPath(), JSON.stringify(cache.results, null, 2));

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n=== 크롤링 완료${teamLabel} ===`);
  console.log(`처리: ${todayCount}건 (성공:${success}, 기록없음:${noRecord}, 에러:${errors})`);
  console.log(`누적: ${completedSet.size}/${totalPairs} (${((completedSet.size / totalPairs) * 100).toFixed(1)}%)`);
  console.log(`소요: ${elapsed}분`);
  console.log(`남은: ${totalPairs - completedSet.size}건`);
  console.log(`결과: ${getResultPath()}`);

  // 검증 리포트
  printVerificationReport(cache.results);

  // 텔레그램 완료 알림
  const pct = ((completedSet.size / totalPairs) * 100).toFixed(1);
  const doneMsg = completedSet.size >= totalPairs ? "🎉 전체 완료!" : `남은: ${totalPairs - completedSet.size}건`;
  await sendTelegram(
    `✅ <b>크롤링 완료${teamLabel}</b>\n` +
    `처리: ${todayCount}건 (성공:${success} 없음:${noRecord} 에러:${errors})\n` +
    `누적: ${completedSet.size}/${totalPairs} (${pct}%)\n` +
    `소요: ${elapsed}분\n${doneMsg}`
  );
}

// ─── 팀별 캐시 병합 ───
function runMerge() {
  const allTeamCodes = Object.values(TEAM_CODE);
  const merged: CrawlCache = { completed: [], results: [], lastUpdated: "" };
  const completedSet = new Set<string>();

  for (const code of allTeamCodes) {
    const cachePath = `scripts/matchup-cache-${code}.json`;
    if (!existsSync(cachePath)) {
      console.log(`  ${code}: 캐시 없음 — 스킵`);
      continue;
    }
    try {
      const teamCache: CrawlCache = JSON.parse(readFileSync(cachePath, "utf-8"));
      let added = 0;
      for (let i = 0; i < teamCache.completed.length; i++) {
        const key = teamCache.completed[i];
        if (!completedSet.has(key)) {
          completedSet.add(key);
          merged.completed.push(key);
          merged.results.push(teamCache.results[i]);
          added++;
        }
      }
      const withStats = teamCache.results.filter(r => r.stats).length;
      console.log(`  ${code} (${CODE_TO_TEAM[code]}): ${teamCache.completed.length}건 (데이터:${withStats}) → ${added}건 추가`);
    } catch (e) {
      console.error(`  ${code}: 파싱 에러 —`, e);
    }
  }

  merged.lastUpdated = new Date().toISOString();
  writeFileSync("scripts/matchup-cache.json", JSON.stringify(merged, null, 2));
  writeFileSync("scripts/matchup-results.json", JSON.stringify(merged.results, null, 2));

  const withStats = merged.results.filter(r => r.stats).length;
  console.log(`\n=== 병합 완료 ===`);
  console.log(`총: ${merged.completed.length}건 (데이터:${withStats}, 없음:${merged.completed.length - withStats})`);
  console.log(`결과: scripts/matchup-cache.json, scripts/matchup-results.json`);

  printVerificationReport(merged.results);
}

// ─── 엔트리포인트 ───
async function main() {
  if (process.argv.includes("--sample")) {
    await runSample();
  } else if (process.argv.includes("--merge")) {
    runMerge();
  } else if (process.argv.includes("--full") || process.argv.includes("--resume")) {
    await runFull();
  } else {
    console.log("사용법:");
    console.log("  npx tsx scripts/crawl-matchup.ts --sample                    # 샘플 (3x3)");
    console.log("  npx tsx scripts/crawl-matchup.ts --full                      # 전체");
    console.log("  npx tsx scripts/crawl-matchup.ts --full --pitcher-team LT    # 특정 투수팀만");
    console.log("  npx tsx scripts/crawl-matchup.ts --resume                    # 이어서 (캐시 기반)");
    console.log("  npx tsx scripts/crawl-matchup.ts --full --limit 3000         # 커스텀 일일 제한");
    console.log("  npx tsx scripts/crawl-matchup.ts --full --delay 2000         # 요청 간격 (ms)");
    console.log("  npx tsx scripts/crawl-matchup.ts --full --fresh              # 캐시 초기화 + 전체");
    console.log("  npx tsx scripts/crawl-matchup.ts --merge                     # 팀별 캐시 병합");
    console.log("\n팀 코드: LG, HH(한화), SK(SSG), SS(삼성), NC, KT, LT(롯데), HT(KIA), OB(두산), WO(키움)");
  }
}

main().catch((e) => {
  console.error("치명적 에러:", e);
  process.exit(1);
});
