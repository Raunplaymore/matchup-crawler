/**
 * KBO 선수 조회 페이지 크롤러
 *
 * /Player/Search.aspx 에서 팀별로 선수 목록을 가져옴.
 * 기록 페이지와 달리 시즌 출장 여부와 무관하게 등록 선수 전원이 나옴.
 */
import * as cheerio from "cheerio";
import { robustFetch, robustFetchWithCookies } from "./lib/http";
import { sendTelegram } from "./lib/telegram";

const BASE = "https://www.koreabaseball.com";
const SEARCH_URL = `${BASE}/Player/Search.aspx`;

// KBO 사이트의 팀 코드 → 우리 팀 ID 매핑
const TEAM_CODES: [string, string][] = [
  ["HT", "KIA"],
  ["SS", "삼성"],
  ["LG", "LG"],
  ["KT", "KT"],
  ["SK", "SSG"],
  ["NC", "NC"],
  ["OB", "두산"],
  ["WO", "키움"],
  ["LT", "롯데"],
  ["HH", "한화"],
];

export interface RosterPlayer {
  name: string;
  team: string;
  position: string;
  detailPosition: string | null;
  backNumber: number | null;
  bats: string | null;
  throws: string | null;
  kboPlayerId: string;
}

// ASP.NET hidden fields 추출
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

// 선수 목록 테이블 파싱
function parseSearchResults(html: string, teamId: string): RosterPlayer[] {
  const $ = cheerio.load(html);
  const players: RosterPlayer[] = [];

  $("table.tEx tbody tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 5) return;

    // 구조: 사진 | 이름(링크) | 포지션 | 투타 | 생년월일 ...
    const link = $(cells[1]).find("a");
    const href = link.attr("href") || "";
    const idMatch = href.match(/playerId=(\d+)/);
    if (!idMatch) return;

    const name = link.text().trim();
    if (!name) return;

    const posText = $(cells[2]).text().trim();
    const btText = $(cells[3]).text().trim(); // "우투우타" 등

    // 포지션 매핑
    let position = "내야수";
    let detailPosition: string | null = null;

    const posMap: Record<string, [string, string]> = {
      "투수": ["투수", "SP"],
      "포수": ["포수", "C"],
      "내야수": ["내야수", "SS"],
      "외야수": ["외야수", "CF"],
      "지명타자": ["지명타자", "DH"],
    };

    if (posMap[posText]) {
      [position, detailPosition] = posMap[posText];
    }

    // 투타
    let bats: string | null = null;
    let throws_: string | null = null;
    const btMatch = btText.match(/(좌|우)(투)(좌|우|양)(타)/);
    if (btMatch) {
      throws_ = btMatch[1];
      bats = btMatch[3];
    }

    // 등번호 — 사진 셀이나 이름 옆에 있을 수 있음
    let backNumber: number | null = null;
    const bnText = $(cells[0]).text().trim();
    const bnMatch = bnText.match(/(\d+)/);
    if (bnMatch) backNumber = parseInt(bnMatch[1]);

    players.push({
      name,
      team: teamId,
      position,
      detailPosition,
      backNumber,
      bats,
      throws: throws_,
      kboPlayerId: idMatch[1],
    });
  });

  return players;
}

// UpdatePanel 응답에서 HTML과 hidden fields 추출
function parseAsyncResponse(text: string, fields: Record<string, string>): { html: string; updatedFields: Record<string, string> } {
  let html = text;
  if (text.includes("|updatePanel|")) {
    const parts = text.split("|");
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === "updatePanel" && i + 2 < parts.length) {
        html = parts[i + 2];
        break;
      }
    }
  }

  const updatedFields = { ...fields };
  const vsMatch = text.match(/__VIEWSTATE\|([^|]*)\|/);
  if (vsMatch) updatedFields["__VIEWSTATE"] = vsMatch[1];
  const evMatch = text.match(/__EVENTVALIDATION\|([^|]*)\|/);
  if (evMatch) updatedFields["__EVENTVALIDATION"] = evMatch[1];
  const vsGenMatch = text.match(/__VIEWSTATEGENERATOR\|([^|]*)\|/);
  if (vsGenMatch) updatedFields["__VIEWSTATEGENERATOR"] = vsGenMatch[1];

  return { html, updatedFields };
}

// 페이지 수 파악
function getPageCount(html: string): number {
  const $ = cheerio.load(html);
  let max = 1;
  $(".paging a, .paging strong, .bbsPaging a, .bbsPaging strong").each((_, el) => {
    const n = parseInt($(el).text().trim());
    if (!isNaN(n) && n > max) max = n;
  });
  return max;
}

async function postAsync(cookies: string, body: URLSearchParams): Promise<string> {
  const res = await robustFetch(SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookies,
      Referer: SEARCH_URL,
      "X-MicrosoftAjax": "Delta=true",
    },
    body: body.toString(),
    timeoutMs: 15000,
    retries: 2,
  });
  return res.text();
}

async function fetchTeamPlayers(teamCode: string, teamId: string, cookies: string, fields: Record<string, string>): Promise<{ players: RosterPlayer[]; updatedFields: Record<string, string> }> {
  // 1) 팀 선택 postback
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    body.set(k, v);
  }
  body.set("ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$ScriptManager1",
    "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$udpRecord|ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$ddlTeam");
  body.set("__EVENTTARGET", "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$ddlTeam");
  body.set("__EVENTARGUMENT", "");
  body.set("ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$ddlTeam", teamCode);
  body.set("ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$ddlPosition", "");
  body.set("__ASYNCPOST", "true");

  const text = await postAsync(cookies, body);
  const { html, updatedFields } = parseAsyncResponse(text, fields);
  let allPlayers = parseSearchResults(html, teamId);

  // 2) 페이지네이션 처리
  const pages = getPageCount(html);
  let currentFields = updatedFields;

  for (let p = 2; p <= pages; p++) {
    await new Promise((r) => setTimeout(r, 500));

    const pageBody = new URLSearchParams();
    for (const [k, v] of Object.entries(currentFields)) {
      pageBody.set(k, v);
    }
    pageBody.set("ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$ScriptManager1",
      "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$udpRecord|ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$ucPager$btnNo${p}");
    pageBody.set("__EVENTTARGET", `ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$ucPager$btnNo${p}`);
    pageBody.set("__EVENTARGUMENT", "");
    pageBody.set("ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$ddlTeam", teamCode);
    pageBody.set("ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$ddlPosition", "");
    pageBody.set("__ASYNCPOST", "true");

    const pageText = await postAsync(cookies, pageBody);
    const pageResult = parseAsyncResponse(pageText, currentFields);
    const pagePlayers = parseSearchResults(pageResult.html, teamId);
    console.log(`    페이지 ${p}: ${pagePlayers.length}명`);
    allPlayers.push(...pagePlayers);
    currentFields = pageResult.updatedFields;
  }

  return { players: allPlayers, updatedFields: currentFields };
}

// 선수 상세 페이지에서 세부 포지션/등번호 보강
async function fetchPlayerDetail(playerId: string, isPitcher: boolean): Promise<{
  detailPosition: string | null;
  backNumber: number | null;
}> {
  const url = isPitcher
    ? `${BASE}/Record/Player/PitcherDetail/Basic.aspx?playerId=${playerId}`
    : `${BASE}/Record/Player/HitterDetail/Basic.aspx?playerId=${playerId}`;

  try {
    const res = await robustFetch(url, { timeoutMs: 15000, retries: 2, retryDelayMs: 1000 });
    const html = await res.text();
    const $ = cheerio.load(html);
    const text = $(".player_info").text() + " " + $(".con").text().substring(0, 2000);

    let backNumber: number | null = null;
    const bnEl = $(".back_num, .backnum");
    if (bnEl.length) {
      const n = parseInt(bnEl.text().replace(/\D/g, ""));
      if (!isNaN(n)) backNumber = n;
    }
    if (!backNumber) {
      const m = text.match(/No\.\s*(\d+)/i);
      if (m) backNumber = parseInt(m[1]);
    }

    let detailPosition: string | null = null;
    const posMap: Record<string, string> = {
      "선발투수": "SP", "구원투수": "RP", "마무리투수": "CP", "중간계투": "RP", "셋업맨": "RP",
      "포수": "C", "1루수": "1B", "2루수": "2B", "3루수": "3B",
      "유격수": "SS", "좌익수": "LF", "중견수": "CF", "우익수": "RF", "지명타자": "DH",
    };
    for (const [kr, code] of Object.entries(posMap)) {
      if (text.includes(kr)) { detailPosition = code; break; }
    }

    return { detailPosition, backNumber };
  } catch {
    return { detailPosition: null, backNumber: null };
  }
}

export async function crawlAllRosters(): Promise<RosterPlayer[]> {
  console.log("=== KBO 선수 조회 크롤링 시작 ===\n");

  // 1. 초기 페이지 로드 (hidden fields + cookies)
  console.log("초기 페이지 로드...");
  const { text: initHtml, cookies } = await robustFetchWithCookies(SEARCH_URL, {
    timeoutMs: 15000,
    retries: 3,
    minResponseSize: 500,
  });
  let fields = extractHiddenFields(initHtml);

  const allPlayers: RosterPlayer[] = [];

  // 2. 팀별로 선수 목록 가져오기
  let currentFields = fields;
  for (const [code, teamId] of TEAM_CODES) {
    console.log(`\n[${teamId}] 조회 중...`);
    await new Promise((r) => setTimeout(r, 800));

    const result = await fetchTeamPlayers(code, teamId, cookies, currentFields);
    console.log(`  ${result.players.length}명 발견`);
    allPlayers.push(...result.players);
    currentFields = result.updatedFields;
  }

  console.log(`\n총 선수: ${allPlayers.length}명`);

  if (allPlayers.length === 0) {
    console.error("선수를 한 명도 가져오지 못했습니다. 크롤링 중단.");
    await sendTelegram(`🚨 <b>[crawl-roster] 크리티컬</b>\n선수 0명. KBO 사이트 점검 필요.`);
    return allPlayers;
  }
  if (allPlayers.length < 100) {
    console.warn(`⚠️ 선수 수가 비정상적으로 적습니다 (${allPlayers.length}명). 사이트 점검 또는 파싱 오류 가능성 확인 필요.`);
    await sendTelegram(`⚠️ <b>[crawl-roster] 경고</b>\n선수 ${allPlayers.length}명 — 비정상적으로 적음.`);
  }

  // 3. 상세 정보가 부족한 선수들의 세부 포지션/등번호 보강
  console.log("\n상세 정보 보강 중...");
  const BATCH = 5;
  let enriched = 0;

  for (let i = 0; i < allPlayers.length; i += BATCH) {
    const batch = allPlayers.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (p) => {
        const isPitcher = p.position === "투수";
        const detail = await fetchPlayerDetail(p.kboPlayerId, isPitcher);
        if (detail.detailPosition) p.detailPosition = detail.detailPosition;
        if (detail.backNumber) p.backNumber = detail.backNumber;
        enriched++;
      })
    );
    process.stdout.write(`  ${Math.min(i + BATCH, allPlayers.length)}/${allPlayers.length}\r`);
    if (i + BATCH < allPlayers.length) await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n\n=== 크롤링 완료: ${allPlayers.length}명 ===`);
  return allPlayers;
}

if (typeof require !== "undefined" && require.main === module) {
  crawlAllRosters()
    .then((players) => {
      // 팀별 요약
      const teamCounts: Record<string, number> = {};
      for (const p of players) {
        teamCounts[p.team] = (teamCounts[p.team] || 0) + 1;
      }
      console.log("\n팀별 선수 수:");
      for (const [team, count] of Object.entries(teamCounts).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${team}: ${count}명`);
      }
    })
    .catch(async (e) => {
      console.error("크롤링 실패:", e);
      await sendTelegram(`🚨 <b>[crawl-roster] 실패</b>\n${String(e).substring(0, 200)}`);
      process.exit(1);
    });
}
