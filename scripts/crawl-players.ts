/**
 * KBO 선수 크롤링 스크립트
 *
 * KBO 공식 사이트의 시즌 기록 페이지에서 선수 정보를 수집.
 * - 타자: /Record/Player/HitterBasic/Basic1.aspx
 * - 투수: /Record/Player/PitcherBasic/Basic1.aspx
 *
 * ASP.NET postback으로 페이지네이션 처리, 선수별 상세 페이지에서 등번호/포지션/투타 정보 수집.
 */
import * as cheerio from "cheerio";
import { robustFetch, robustFetchWithCookies } from "./lib/http";
import { sendTelegram } from "./lib/telegram";

const BASE = "https://www.koreabaseball.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

const TEAM_MAP: Record<string, string> = {
  LG: "LG", 한화: "한화", SSG: "SSG", 삼성: "삼성",
  NC: "NC", KT: "KT", 롯데: "롯데", KIA: "KIA",
  두산: "두산", 키움: "키움",
};

export interface CrawledPlayer {
  name: string;
  team: string;
  position: string;
  detailPosition: string | null;
  backNumber: number | null;
  bats: string | null;
  throws: string | null;
  kboPlayerId: string;
}

// 테이블에서 선수 ID/이름/팀 추출
function parseTable(html: string): { id: string; name: string; team: string }[] {
  const $ = cheerio.load(html);
  const players: { id: string; name: string; team: string }[] = [];

  $("table.tData01 tbody tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 3) return;
    const link = $(cells[1]).find("a");
    const href = link.attr("href") || "";
    const m = href.match(/playerId=(\d+)/);
    if (!m) return;
    const name = link.text().trim();
    const team = $(cells[2]).text().trim();
    if (name && TEAM_MAP[team]) {
      players.push({ id: m[1], name, team: TEAM_MAP[team] });
    }
  });
  return players;
}

// 페이지 수 파악
function getPageCount(html: string): number {
  const $ = cheerio.load(html);
  let max = 1;
  $(".paging a, .paging strong").each((_, el) => {
    const n = parseInt($(el).text().trim());
    if (!isNaN(n) && n > max) max = n;
  });
  return max;
}

// ASP.NET hidden fields를 URLSearchParams로 수집
function buildPostback(html: string, eventTarget: string): URLSearchParams {
  const $ = cheerio.load(html);
  const body = new URLSearchParams();

  $("input[type=hidden]").each((_, el) => {
    const name = $(el).attr("name");
    const val = $(el).val() as string;
    if (name) body.set(name, val || "");
  });

  body.set("__EVENTTARGET", eventTarget);
  body.set("__EVENTARGUMENT", "");

  return body;
}

// 한 카테고리(타자/투수) 전체 페이지 수집
async function crawlCategory(url: string): Promise<{ id: string; name: string; team: string }[]> {
  console.log(`  Fetching: ${url}`);
  const { text: html, cookies } = await robustFetchWithCookies(url, {
    timeoutMs: 30000,
    retries: 3,
    minResponseSize: 500,
  });

  let all = parseTable(html);
  const pages = getPageCount(html);
  console.log(`  Page 1: ${all.length} players, total pages: ${pages}`);

  if (all.length === 0) {
    console.warn("  ⚠️ 첫 페이지에서 선수를 찾지 못했습니다. HTML 구조 변경 가능성.");
    return all;
  }

  let currentHtml = html;
  for (let p = 2; p <= pages; p++) {
    const target = `ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$ucPager$btnNo${p}`;
    const body = buildPostback(currentHtml, target);

    await new Promise((r) => setTimeout(r, 500));

    try {
      const res2 = await robustFetch(url, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookies,
          Referer: url,
        },
        body: body.toString(),
        timeoutMs: 30000,
        retries: 2,
      });

      if (!res2.ok) {
        console.warn(`  ⚠️ Page ${p} 요청 실패 (${res2.status}), 건너뜀`);
        continue;
      }

      currentHtml = await res2.text();
      const pagePlayers = parseTable(currentHtml);
      console.log(`  Page ${p}: ${pagePlayers.length} players`);
      all = all.concat(pagePlayers);
    } catch (e) {
      console.warn(`  ⚠️ Page ${p} 실패, 건너뜀: ${e}`);
    }
  }

  return all;
}

// 선수 상세 페이지에서 세부 정보 추출
async function fetchDetail(playerId: string, isPitcher: boolean) {
  const url = isPitcher
    ? `${BASE}/Record/Player/PitcherDetail/Basic.aspx?playerId=${playerId}`
    : `${BASE}/Record/Player/HitterDetail/Basic.aspx?playerId=${playerId}`;

  try {
    const res = await robustFetch(url, { timeoutMs: 15000, retries: 2, retryDelayMs: 1000 });
    const html = await res.text();
    const $ = cheerio.load(html);

    const text = $(".player_info").text() + " " + $(".con").text().substring(0, 2000);

    // 등번호
    let backNumber: number | null = null;
    const bnEl = $(".back_num, .backnum");
    if (bnEl.length) {
      const n = parseInt(bnEl.text().replace(/\D/g, ""));
      if (!isNaN(n)) backNumber = n;
    }
    if (!backNumber) {
      const bnMatch = text.match(/No\.\s*(\d+)/i);
      if (bnMatch) backNumber = parseInt(bnMatch[1]);
    }

    // 투타
    let bats: string | null = null;
    let throws_: string | null = null;
    const btMatch = text.match(/(좌투좌타|좌투우타|좌투양타|우투좌타|우투우타|우투양타)/);
    if (btMatch) {
      throws_ = btMatch[1][0];
      bats = btMatch[1][2];
    }

    // 포지션
    let detailPosition: string | null = null;
    const posMap: Record<string, string> = {
      선발투수: "SP", 구원투수: "RP", 마무리투수: "CP", 중간계투: "RP", 셋업맨: "RP",
      포수: "C", "1루수": "1B", "2루수": "2B", "3루수": "3B",
      유격수: "SS", 좌익수: "LF", 중견수: "CF", 우익수: "RF", 지명타자: "DH",
    };
    for (const [kr, code] of Object.entries(posMap)) {
      if (text.includes(kr)) { detailPosition = code; break; }
    }

    return { detailPosition, backNumber, bats, throws: throws_ };
  } catch (e) {
    console.warn(`  상세 페이지 실패 (${playerId}): ${e}`);
    return { detailPosition: null, backNumber: null, bats: null, throws: null };
  }
}

function guessPosition(dp: string | null): string {
  if (!dp) return "내야수";
  if (dp === "C") return "포수";
  if (["1B", "2B", "3B", "SS"].includes(dp)) return "내야수";
  if (["LF", "CF", "RF"].includes(dp)) return "외야수";
  if (dp === "DH") return "지명타자";
  return "내야수";
}

export async function crawlAllPlayers(): Promise<CrawledPlayer[]> {
  console.log("=== KBO 선수 크롤링 시작 ===\n");

  console.log("[타자]");
  const hitters = await crawlCategory(`${BASE}/Record/Player/HitterBasic/Basic1.aspx`);

  console.log("\n[투수]");
  const pitchers = await crawlCategory(`${BASE}/Record/Player/PitcherBasic/Basic1.aspx`);

  // 중복 제거 (ID 기준)
  const unique = new Map<string, { id: string; name: string; team: string; isPitcher: boolean }>();
  for (const p of pitchers) unique.set(p.id, { ...p, isPitcher: true });
  for (const p of hitters) if (!unique.has(p.id)) unique.set(p.id, { ...p, isPitcher: false });

  console.log(`\n총 고유 선수: ${unique.size}명`);

  if (unique.size === 0) {
    console.error("❌ 선수를 찾지 못했습니다. KBO 사이트 상태를 확인하세요.");
    await sendTelegram(`🚨 <b>[crawl-players] 크리티컬</b>\n선수를 한 명도 찾지 못했습니다. KBO 사이트 상태 확인 필요.`);
    return [];
  }

  if (unique.size < 100) {
    console.warn(`⚠️ 선수가 ${unique.size}명으로 비정상적으로 적습니다.`);
    await sendTelegram(`⚠️ <b>[crawl-players] 경고</b>\n선수 ${unique.size}명 — 비정상적으로 적음. 크롤링 오류 가능성.`);
  }

  console.log("상세 정보 수집 중...\n");

  const entries = Array.from(unique.entries());
  const results: CrawledPlayer[] = [];
  const BATCH = 5;

  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(async ([id, p]) => {
        const d = await fetchDetail(id, p.isPitcher);
        return {
          name: p.name,
          team: p.team,
          position: p.isPitcher ? "투수" : guessPosition(d.detailPosition),
          detailPosition: p.isPitcher && !d.detailPosition ? "SP" : d.detailPosition,
          backNumber: d.backNumber,
          bats: d.bats,
          throws: d.throws,
          kboPlayerId: id,
        };
      })
    );
    results.push(...batchResults);
    process.stdout.write(`  ${results.length}/${entries.length} 완료\r`);
    if (i + BATCH < entries.length) await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n\n=== 크롤링 완료: ${results.length}명 ===`);
  return results;
}

if (require.main === module) {
  crawlAllPlayers()
    .then((players) => console.log(JSON.stringify(players, null, 2)))
    .catch(async (e) => {
      console.error("크롤링 실패:", e);
      await sendTelegram(`🚨 <b>[crawl-players] 실패</b>\n${String(e).substring(0, 200)}`);
      process.exit(1);
    });
}
