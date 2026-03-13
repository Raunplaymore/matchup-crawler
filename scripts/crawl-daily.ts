/**
 * 일일 맞대결 업데이트 크롤러
 *
 * 당일 경기에 참여한 팀의 투수×상대팀 타자 맞대결만 크롤링.
 * 전수 크롤링(~95K쌍) 대신 경기 팀만 대상 → 대폭 축소.
 *
 * 플로우:
 *   1. KBO 스케줄 API → 당일 경기 목록 (팀 쌍)
 *   2. crawled-players.json에서 해당 팀 선수 필터
 *   3. 투수(팀A) × 타자(팀B) 맞대결 크롤링
 *   4. 결과 저장 → D1 UPSERT (upload-d1.ts --upsert)
 *
 * 사용법:
 *   npx tsx scripts/crawl-daily.ts                    # 오늘 경기
 *   npx tsx scripts/crawl-daily.ts --date 20260322    # 특정 날짜
 *   npx tsx scripts/crawl-daily.ts --dry-run          # 대상만 확인
 *   npx tsx scripts/crawl-daily.ts --delay 2000       # 요청 간격 (ms)
 */
import * as cheerio from "cheerio";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { robustFetch, robustFetchWithCookies } from "./lib/http";

// ─── 설정 ───
const BASE = "https://www.koreabaseball.com";
const MATCHUP_URL = `${BASE}/Record/Etc/HitVsPit.aspx`;

const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

// KBO 팀코드 매핑
const TEAM_CODE: Record<string, string> = {
  LG: "LG",
  한화: "HH",
  SSG: "SK",
  삼성: "SS",
  NC: "NC",
  KT: "KT",
  롯데: "LT",
  KIA: "HT",
  두산: "OB",
  키움: "WO",
};
const CODE_TO_TEAM: Record<string, string> = Object.fromEntries(
  Object.entries(TEAM_CODE).map(([name, code]) => [code, name])
);

const CTL = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents";

// ─── CLI ───
function getCliOption(flag: string, defaultVal: string): string {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return defaultVal;
  return process.argv[idx + 1];
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── 타입 ───
interface GameInfo {
  gameId: string;
  awayTeamCode: string;
  homeTeamCode: string;
  awayTeam: string;
  homeTeam: string;
}

interface PlayerInfo {
  name: string;
  team: string;
  teamCode: string;
  kboPlayerId: string;
  position: string;
}

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

// ─── 텔레그램 ───
async function sendTelegram(text: string) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "HTML" }),
    });
  } catch {}
}

// ─── 경기 목록 조회 ───
async function fetchGameList(dateStr: string): Promise<GameInfo[]> {
  const year = parseInt(dateStr.substring(0, 4));
  let srId = "0,1,3,4,5,7,9";
  if (year >= 2021) srId = "0,1,3,4,5,6,7,9";
  if (dateStr >= "20241026") srId = "0,1,3,4,5,6,7,8,9";

  try {
    // ASMX JSON 호출: Content-Type must be application/json for JSON response
    const res = await robustFetch(`${BASE}/ws/Main.asmx/GetKboGameList`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ leId: "1", srId, date: dateStr }),
      timeoutMs: 15000,
      retries: 2,
    });

    const text = await res.text();

    // ASMX가 XML을 반환하면 폴백
    if (text.startsWith("<?xml") || text.startsWith("<")) {
      throw new Error("XML response — JSON not supported");
    }

    // ASMX 응답: JSON 뒤에 HTML이 붙는 경우가 있음 → 첫 번째 JSON 객체만 추출
    let jsonEnd = 0;
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) {
          jsonEnd = i + 1;
          break;
        }
      }
    }
    if (jsonEnd === 0) throw new Error("No JSON found in response");

    const json = JSON.parse(text.substring(0, jsonEnd)) as Record<
      string,
      unknown
    >;

    // ASMX JSON wrapper: { d: { game: [...] } } or { game: [...] }
    const data = (json.d || json) as Record<string, unknown>;
    const games = (data.game || []) as Record<string, string>[];

    // 필드명 대문자 (AWAY_ID, HOME_ID, G_ID)
    return games
      .filter((g) => (g.AWAY_ID || g.away_id) && (g.HOME_ID || g.home_id))
      .map((g) => ({
        gameId: g.G_ID || g.g_id || "",
        awayTeamCode: g.AWAY_ID || g.away_id,
        homeTeamCode: g.HOME_ID || g.home_id,
        awayTeam: CODE_TO_TEAM[g.AWAY_ID || g.away_id] || g.AWAY_NM || g.AWAY_ID || g.away_id,
        homeTeam: CODE_TO_TEAM[g.HOME_ID || g.home_id] || g.HOME_NM || g.HOME_ID || g.home_id,
      }));
  } catch (e) {
    console.log(`ASMX API 실패 (${e}), 스코어보드 페이지로 폴백...`);
    return fetchGameListFromScoreboard(dateStr);
  }
}

// 폴백: 스코어보드 페이지에서 경기 목록 스크래핑
async function fetchGameListFromScoreboard(
  dateStr: string
): Promise<GameInfo[]> {
  const url = `${BASE}/Schedule/ScoreBoard.aspx`;
  const res = await robustFetch(url, { timeoutMs: 15000, retries: 3 });
  const html = await res.text();
  const $ = cheerio.load(html);

  const games: GameInfo[] = [];

  // 스코어보드 경기 블록에서 팀 정보 추출
  $(".smsScore").each((_, el) => {
    const teams = $(el).find(".team span");
    if (teams.length >= 2) {
      const awayName = $(teams[0]).text().trim();
      const homeName = $(teams[1]).text().trim();
      const awayCode = TEAM_CODE[awayName];
      const homeCode = TEAM_CODE[homeName];

      if (awayCode && homeCode) {
        games.push({
          gameId: `${dateStr}${awayCode}${homeCode}0`,
          awayTeamCode: awayCode,
          homeTeamCode: homeCode,
          awayTeam: awayName,
          homeTeam: homeName,
        });
      }
    }
  });

  return games;
}

// ─── 선수 로드 ───
function loadPlayers(): PlayerInfo[] {
  const raw = JSON.parse(readFileSync("scripts/crawled-players.json", "utf-8"));
  return raw
    .filter((p: Record<string, string>) => p.kboPlayerId && TEAM_CODE[p.team])
    .map((p: Record<string, string>) => ({
      name: p.name,
      team: p.team,
      teamCode: TEAM_CODE[p.team],
      kboPlayerId: p.kboPlayerId,
      position: p.position,
    }));
}

// ─── ASP.NET 유틸 (crawl-matchup.ts 공유) ───
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
  for (const [k, v] of Object.entries(hiddenFields)) body.set(k, v);
  for (const [k, v] of Object.entries(overrides)) body.set(k, v);
  return body;
}

// ─── 결과 파싱 ───
function parseMatchupTable(html: string): MatchupResult["stats"] | null {
  const $ = cheerio.load(html);
  if (html.includes("기록이 없습니다")) return null;

  const rows = $("table.tData tbody tr");
  if (rows.length === 0) return null;

  const cells = $(rows[0]).find("td");
  if (cells.length < 14) return null;

  const text = (i: number) => $(cells[i]).text().trim();
  const num = (i: number) => parseInt(text(i)) || 0;

  return {
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
}

// ─── KBO 세션 (맞대결 크롤링) ───
class KBOSession {
  private cookies = "";
  private hiddenFields: Record<string, string> = {};
  private currentPitcherTeam = "";
  private currentHitterTeam = "";

  async init(): Promise<boolean> {
    try {
      const { text: html, cookies } = await robustFetchWithCookies(MATCHUP_URL, {
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

  async selectPitcherTeam(teamCode: string): Promise<boolean> {
    if (this.currentPitcherTeam === teamCode) return true;
    try {
      const body = buildPostBody(this.hiddenFields, {
        __EVENTTARGET: `${CTL}$ddlPitcherTeam`,
        __EVENTARGUMENT: "",
        [`${CTL}$ddlPitcherTeam`]: teamCode,
        [`${CTL}$ddlHitterTeam`]: this.currentHitterTeam || "",
      });
      const res = await robustFetch(MATCHUP_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: this.cookies,
          Referer: MATCHUP_URL,
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

  async selectHitterTeam(teamCode: string): Promise<boolean> {
    if (this.currentHitterTeam === teamCode) return true;
    try {
      const body = buildPostBody(this.hiddenFields, {
        __EVENTTARGET: `${CTL}$ddlHitterTeam`,
        __EVENTARGUMENT: "",
        [`${CTL}$ddlPitcherTeam`]: this.currentPitcherTeam,
        [`${CTL}$ddlHitterTeam`]: teamCode,
      });
      const res = await robustFetch(MATCHUP_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: this.cookies,
          Referer: MATCHUP_URL,
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

  async search(
    pitcherId: string,
    hitterId: string
  ): Promise<MatchupResult["stats"] | null | "error"> {
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
      body.set(
        `${CTL}$ScriptManager1`,
        `${CTL}$udpRecord|${CTL}$btnSearch`
      );
      body.set("__ASYNCPOST", "true");

      const res = await robustFetch(MATCHUP_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: this.cookies,
          Referer: MATCHUP_URL,
        },
        body: body.toString(),
        timeoutMs: 30000,
        retries: 3,
      });

      const html = await res.text();
      if (html.includes("__VIEWSTATE")) {
        if (html.includes("<html")) {
          this.hiddenFields = extractHiddenFields(html);
        } else {
          const vsMatch = html.match(/__VIEWSTATE\|([^|]*)\|/);
          if (vsMatch) this.hiddenFields["__VIEWSTATE"] = vsMatch[1];
          const evMatch = html.match(/__EVENTVALIDATION\|([^|]*)\|/);
          if (evMatch) this.hiddenFields["__EVENTVALIDATION"] = evMatch[1];
        }
      }
      return parseMatchupTable(html);
    } catch (e) {
      console.error(
        `  검색 실패 (pitcher=${pitcherId}, hitter=${hitterId}):`,
        e
      );
      return "error";
    }
  }
}

// ─── 메인 ───
async function main() {
  const today = new Date();
  const defaultDate =
    today.getFullYear().toString() +
    (today.getMonth() + 1).toString().padStart(2, "0") +
    today.getDate().toString().padStart(2, "0");

  const dateStr = getCliOption("--date", defaultDate);
  const isDryRun = process.argv.includes("--dry-run");
  const delayMs = parseInt(getCliOption("--delay", "3000"));
  const sessionRefresh = parseInt(getCliOption("--refresh", "40"));

  console.log(`=== 일일 맞대결 업데이트 (${dateStr}) ===\n`);

  // 1. 경기 목록 조회
  console.log("경기 목록 조회...");
  const games = await fetchGameList(dateStr);

  if (games.length === 0) {
    console.log("경기 없음 → 종료");
    return;
  }

  console.log(`${games.length}경기:`);
  for (const g of games) {
    console.log(`  ${g.awayTeam} @ ${g.homeTeam}`);
  }

  // 2. 경기 팀 기반 매치업 쌍 구성
  const allPlayers = loadPlayers();
  const pairs: { pitcher: PlayerInfo; hitter: PlayerInfo }[] = [];

  // 중복 팀 쌍 제거 (더블헤더 대응)
  const gamePairs = new Set<string>();

  for (const game of games) {
    const pairKey1 = `${game.awayTeamCode}:${game.homeTeamCode}`;
    const pairKey2 = `${game.homeTeamCode}:${game.awayTeamCode}`;

    if (!gamePairs.has(pairKey1)) {
      gamePairs.add(pairKey1);
      // 원정팀 투수 → 홈팀 타자
      const awayPitchers = allPlayers.filter(
        (p) => p.teamCode === game.awayTeamCode && p.position === "투수"
      );
      const homeHitters = allPlayers.filter(
        (p) => p.teamCode === game.homeTeamCode && p.position !== "투수"
      );
      for (const pitcher of awayPitchers) {
        for (const hitter of homeHitters) {
          pairs.push({ pitcher, hitter });
        }
      }
    }

    if (!gamePairs.has(pairKey2)) {
      gamePairs.add(pairKey2);
      // 홈팀 투수 → 원정팀 타자
      const homePitchers = allPlayers.filter(
        (p) => p.teamCode === game.homeTeamCode && p.position === "투수"
      );
      const awayHitters = allPlayers.filter(
        (p) => p.teamCode === game.awayTeamCode && p.position !== "투수"
      );
      for (const pitcher of homePitchers) {
        for (const hitter of awayHitters) {
          pairs.push({ pitcher, hitter });
        }
      }
    }
  }

  // 팀별 요약
  const pitcherTeams = new Map<string, number>();
  const hitterTeams = new Map<string, number>();
  const pitcherSet = new Set<string>();
  const hitterSet = new Set<string>();
  for (const { pitcher, hitter } of pairs) {
    pitcherSet.add(pitcher.kboPlayerId);
    hitterSet.add(hitter.kboPlayerId);
    pitcherTeams.set(
      pitcher.team,
      (pitcherTeams.get(pitcher.team) || 0) + 1
    );
    hitterTeams.set(hitter.team, (hitterTeams.get(hitter.team) || 0) + 1);
  }

  console.log(
    `\n대상: ${pairs.length}쌍 (투수 ${pitcherSet.size}명, 타자 ${hitterSet.size}명)`
  );
  console.log(
    `투수팀: ${Array.from(pitcherTeams.entries())
      .map(([t, c]) => `${t}(${c})`)
      .join(" ")}`
  );
  console.log(
    `타자팀: ${Array.from(hitterTeams.entries())
      .map(([t, c]) => `${t}(${c})`)
      .join(" ")}`
  );

  const estimatedHours = (pairs.length * (delayMs / 1000)) / 3600;
  console.log(
    `예상 소요: ~${estimatedHours.toFixed(1)}시간 (간격: ${delayMs / 1000}초)`
  );

  if (isDryRun) {
    console.log("\n[DRY RUN] 크롤링 없이 종료");
    return;
  }

  // 3. 크롤링
  await sendTelegram(
    `⚾ <b>일일 맞대결 업데이트 시작</b> (${dateStr})\n` +
      `${games.length}경기, ${pairs.length}쌍 (투수 ${pitcherSet.size} × 타자 ${hitterSet.size})`
  );

  const session = new KBOSession();
  let sessionAge = 0;
  const results: MatchupResult[] = [];
  let success = 0;
  let noRecord = 0;
  let errors = 0;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 10;
  const startTime = Date.now();

  // 투수팀→타자팀 순서로 그룹화 (세션 재사용 최대화)
  const grouped = new Map<
    string,
    Map<string, { pitcher: PlayerInfo; hitter: PlayerInfo }[]>
  >();
  for (const pair of pairs) {
    const ptKey = pair.pitcher.teamCode;
    const htKey = pair.hitter.teamCode;
    if (!grouped.has(ptKey)) grouped.set(ptKey, new Map());
    const htMap = grouped.get(ptKey)!;
    if (!htMap.has(htKey)) htMap.set(htKey, []);
    htMap.get(htKey)!.push(pair);
  }

  let processed = 0;

  for (const [pitcherTeamCode, hitterTeamMap] of grouped) {
    for (const [hitterTeamCode, teamPairs] of hitterTeamMap) {
      const pitcherTeamName = CODE_TO_TEAM[pitcherTeamCode] || pitcherTeamCode;
      const hitterTeamName = CODE_TO_TEAM[hitterTeamCode] || hitterTeamCode;
      console.log(
        `\n[${pitcherTeamName} 투수 vs ${hitterTeamName} 타자] ${teamPairs.length}건`
      );

      // 세션 초기화/리프레시
      if (sessionAge === 0 || sessionAge >= sessionRefresh) {
        console.log(
          `  세션 ${sessionAge === 0 ? "초기화" : "리프레시"}...`
        );
        if (!(await session.init())) {
          await sleep(30000);
          if (!(await session.init())) continue;
        }
        sessionAge = 0;
      }

      // 팀 선택
      if (!(await session.selectPitcherTeam(pitcherTeamCode))) {
        await session.init();
        if (!(await session.selectPitcherTeam(pitcherTeamCode))) continue;
        sessionAge = 0;
      }
      await sleep(1000);

      if (!(await session.selectHitterTeam(hitterTeamCode))) {
        await session.init();
        if (!(await session.selectPitcherTeam(pitcherTeamCode))) continue;
        if (!(await session.selectHitterTeam(hitterTeamCode))) continue;
        sessionAge = 0;
      }
      await sleep(1000);

      for (const { pitcher, hitter } of teamPairs) {
        const stats = await session.search(
          pitcher.kboPlayerId,
          hitter.kboPlayerId
        );
        sessionAge++;
        processed++;
        await sleep(delayMs);

        if (stats === "error") {
          errors++;
          consecutiveErrors++;

          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            console.log(
              `  연속 에러 ${MAX_CONSECUTIVE_ERRORS}회 → 60초 대기`
            );
            await sleep(60000);
            if (!(await session.init())) break;
            if (!(await session.selectPitcherTeam(pitcherTeamCode))) break;
            if (!(await session.selectHitterTeam(hitterTeamCode))) break;
            sessionAge = 0;
            consecutiveErrors = 0;
          }
          continue;
        }

        consecutiveErrors = 0;
        results.push({
          pitcherId: pitcher.kboPlayerId,
          pitcherName: pitcher.name,
          pitcherTeam: pitcher.team,
          hitterId: hitter.kboPlayerId,
          hitterName: hitter.name,
          hitterTeam: hitter.team,
          stats,
        });

        if (stats) success++;
        else noRecord++;

        // 100건마다 진행률
        if (processed % 100 === 0) {
          const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
          const pct = ((processed / pairs.length) * 100).toFixed(1);
          console.log(
            `  [${processed}/${pairs.length}] ${pct}% | 성공:${success} 없음:${noRecord} 에러:${errors} | ${elapsed}분`
          );
        }
      }
    }
  }

  // 4. 결과 저장
  const resultPath = `scripts/daily-${dateStr}.json`;
  writeFileSync(resultPath, JSON.stringify(results, null, 2));

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  const withStats = results.filter((r) => r.stats).length;

  console.log(`\n=== 일일 업데이트 완료 (${dateStr}) ===`);
  console.log(
    `처리: ${processed}건 (성공:${success}, 없음:${noRecord}, 에러:${errors})`
  );
  console.log(`결과: ${withStats}건 저장 → ${resultPath}`);
  console.log(`소요: ${elapsed}분`);

  await sendTelegram(
    `✅ <b>일일 맞대결 완료</b> (${dateStr})\n` +
      `처리: ${processed}건 (데이터:${withStats})\n소요: ${elapsed}분`
  );
}

main().catch((e) => {
  console.error("치명적 에러:", e);
  sendTelegram(`❌ <b>일일 맞대결 실패</b>\n${e}`).finally(() =>
    process.exit(1)
  );
});
