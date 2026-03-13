/**
 * KBO 수비 기록 크롤링 스크립트
 *
 * KBO 공식 사이트 수비 기록 페이지에서 2025 시즌 출장 선수를 수집.
 * 수비 기록이 가장 포괄적 (827명) — 타자+투수 기록 페이지보다 넓은 범위.
 *
 * URL: /Record/Player/Defense/Basic.aspx
 *
 * 사이트가 불안정하므로 그룹(5페이지) 단위 캐시 사용:
 * - 성공한 그룹은 scripts/defense-cache.json에 저장
 * - 다음 실행시 성공 그룹 스킵, 실패 그룹만 재시도
 * - --fresh 옵션으로 캐시 초기화
 */
import * as cheerio from "cheerio";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { robustFetch, robustFetchWithCookies } from "./lib/http";
import { sendTelegram } from "./lib/telegram";

const BASE = "https://www.koreabaseball.com";

const TEAM_MAP: Record<string, string> = {
  LG: "LG", 한화: "한화", SSG: "SSG", 삼성: "삼성",
  NC: "NC", KT: "KT", 롯데: "롯데", KIA: "KIA",
  두산: "두산", 키움: "키움",
};

// 수비 포지션 (한글) → 대분류 + 세부포지션 매핑
const POS_MAP: Record<string, { position: string; detail: string }> = {
  투수: { position: "투수", detail: "SP" },
  포수: { position: "포수", detail: "C" },
  "1루수": { position: "내야수", detail: "1B" },
  "2루수": { position: "내야수", detail: "2B" },
  "3루수": { position: "내야수", detail: "3B" },
  유격수: { position: "내야수", detail: "SS" },
  좌익수: { position: "외야수", detail: "LF" },
  중견수: { position: "외야수", detail: "CF" },
  우익수: { position: "외야수", detail: "RF" },
  지명타자: { position: "지명타자", detail: "DH" },
  외야수: { position: "외야수", detail: "LF" }, // fallback
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

// 수비 기록 테이블에서 선수 추출 (ID, 이름, 팀, 포지션)
function parseDefenseTable(html: string): { id: string; name: string; team: string; pos: string }[] {
  const $ = cheerio.load(html);
  const players: { id: string; name: string; team: string; pos: string }[] = [];

  $("table.tData01 tbody tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 4) return;

    // 컬럼: 순위(0), 선수명(1), 팀(2), POS(3), ...
    const link = $(cells[1]).find("a");
    const href = link.attr("href") || "";
    const m = href.match(/playerId=(\d+)/);
    if (!m) return;

    const name = link.text().trim();
    const team = $(cells[2]).text().trim();
    const pos = $(cells[3]).text().trim();

    if (name && TEAM_MAP[team]) {
      players.push({ id: m[1], name, team: TEAM_MAP[team], pos });
    }
  });
  return players;
}

// 페이지 수 파악 — "다음" 버튼 존재 여부도 확인
function getPageInfo(html: string): { maxPage: number; hasNext: boolean } {
  const $ = cheerio.load(html);
  let maxPage = 1;
  $(".paging a, .paging strong").each((_, el) => {
    const n = parseInt($(el).text().trim());
    if (!isNaN(n) && n > maxPage) maxPage = n;
  });
  // "다음" 버튼이 있으면 더 많은 페이지 존재
  const hasNext = $(".paging a").filter((_, el) => {
    const href = $(el).attr("href") || "";
    return href.includes("btnNext");
  }).length > 0;
  return { maxPage, hasNext };
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

// 선수 상세 페이지에서 등번호, 투타 추출
async function fetchDetail(playerId: string) {
  // 수비 기록의 선수는 대부분 타자 → HitterDetail 먼저 시도
  const url = `${BASE}/Record/Player/HitterDetail/Basic.aspx?playerId=${playerId}`;
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

    return { backNumber, bats, throws: throws_ };
  } catch {
    return { backNumber: null, bats: null, throws: null };
  }
}

// POST 요청 + 재시도
async function postWithRetry(
  url: string, body: URLSearchParams, cookies: string, retries = 3
): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await new Promise((r) => setTimeout(r, 800 + (attempt - 1) * 1500));
      const res = await robustFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookies,
          Referer: url,
        },
        body: body.toString(),
        timeoutMs: 15000,
        retries: 1, // outer loop handles retries
      });
      const html = await res.text();
      if (html.includes("tData01")) return html;
      if (attempt < retries) console.log(`    재시도 ${attempt}/${retries} (빈 응답)...`);
    } catch (e) {
      if (attempt < retries) console.log(`    재시도 ${attempt}/${retries}: ${e}`);
      else throw e;
    }
  }
  return "";
}

// 새 세션으로 특정 그룹까지 빠르게 이동 (btnNext N번)
async function startFreshSession(url: string, groupIndex: number): Promise<{ html: string; cookies: string } | null> {
  try {
    const session = await robustFetchWithCookies(url, { timeoutMs: 15000, retries: 3, minResponseSize: 500 });
    let html = session.text;
    const cookies = session.cookies;

    // groupIndex=0 → page 1 (group 1-5), groupIndex=1 → pages 6-10, etc.
    for (let g = 0; g < groupIndex; g++) {
      await new Promise((r) => setTimeout(r, 800));
      const target = `ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$ucPager$btnNext`;
      const body = buildPostback(html, target);
      html = await postWithRetry(url, body, cookies, 3);
      if (!html) return null;
    }
    return { html, cookies };
  } catch {
    return null;
  }
}

// 한 그룹(5페이지) 크롤링 시도
async function crawlGroup(
  url: string, groupIndex: number
): Promise<{ players: { id: string; name: string; team: string; pos: string }[]; isLast: boolean; pagesOk: number }> {
  const session = await startFreshSession(url, groupIndex);
  if (!session) return { players: [], isLast: false, pagesOk: 0 };

  let currentHtml = session.html;
  const cookies = session.cookies;
  const players: { id: string; name: string; team: string; pos: string }[] = [];

  // 그룹 첫 페이지
  const firstPlayers = parseDefenseTable(currentHtml);
  if (firstPlayers.length === 0) return { players: [], isLast: true, pagesOk: 0 };
  players.push(...firstPlayers);
  let pagesOk = 1;

  // 나머지 페이지 (btnNo2~5)
  for (let btnIdx = 2; btnIdx <= 5; btnIdx++) {
    const target = `ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$ucPager$btnNo${btnIdx}`;
    const body = buildPostback(currentHtml, target);

    const html = await postWithRetry(url, body, cookies);
    if (!html) break; // 세션 끊김 — 수집된 데이터는 유지
    currentHtml = html;

    const pagePlayers = parseDefenseTable(currentHtml);
    if (pagePlayers.length === 0) {
      return { players, isLast: true, pagesOk };
    }
    players.push(...pagePlayers);
    pagesOk++;
  }

  const info = getPageInfo(currentHtml);
  const isLast = pagesOk === 5 && info.maxPage > 1 && !info.hasNext;

  return { players, isLast, pagesOk };
}

// 그룹 캐시 — 성공한 그룹 저장, 실패 그룹만 재시도
interface GroupCache {
  [groupIndex: string]: {
    players: { id: string; name: string; team: string; pos: string }[];
    pagesOk: number;
    isLast: boolean;
  };
}

const CACHE_PATH = "scripts/defense-cache.json";

function loadGroupCache(): GroupCache {
  if (process.argv.includes("--fresh")) return {};
  if (!existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveGroupCache(cache: GroupCache) {
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// 한 카테고리 전체 페이지 수집
// 전략: 그룹 캐시 사용 — 5/5 성공한 그룹은 스킵, 실패 그룹만 재시도
async function crawlCategory(url: string): Promise<{ id: string; name: string; team: string; pos: string }[]> {
  const cache = loadGroupCache();
  const MAX_GROUP_RETRIES = 5;
  const MAX_GROUPS = 10;
  let consecutiveEmptyGroups = 0;

  // 캐시된 그룹 현황
  const cachedGroups = Object.keys(cache).map(Number).sort((a, b) => a - b);
  if (cachedGroups.length > 0) {
    console.log(`  캐시된 그룹: ${cachedGroups.map(g => `G${g + 1}(${cache[g].pagesOk}/5)`).join(", ")}`);
  }

  for (let groupIndex = 0; groupIndex < MAX_GROUPS; groupIndex++) {
    const firstPageNum = groupIndex * 5 + 1;
    const cached = cache[groupIndex];

    // 이미 5/5 성공했거나 isLast인 캐시 있으면 스킵
    if (cached && (cached.pagesOk >= 5 || cached.isLast)) {
      console.log(`  [Group ${groupIndex + 1}] 캐시 사용 (${cached.pagesOk}/5, ${cached.players.length}명)`);
      if (cached.isLast) break;
      continue;
    }

    // 실패했던 그룹 → 재시도
    let best: Awaited<ReturnType<typeof crawlGroup>> = cached
      ? { players: cached.players, isLast: cached.isLast, pagesOk: cached.pagesOk }
      : { players: [], isLast: false, pagesOk: 0 };

    for (let attempt = 1; attempt <= MAX_GROUP_RETRIES; attempt++) {
      console.log(`  [Group ${groupIndex + 1}, pages ${firstPageNum}-${firstPageNum + 4}] 시도 ${attempt}/${MAX_GROUP_RETRIES}`);
      await new Promise((r) => setTimeout(r, attempt > 1 ? 2000 + attempt * 1000 : 0));

      const result = await crawlGroup(url, groupIndex);
      if (result.pagesOk > best.pagesOk) best = result;
      if (result.pagesOk >= 5 || result.isLast) break;
      if (attempt < MAX_GROUP_RETRIES) {
        console.log(`    ${result.pagesOk}/5 페이지만 성공, 재시도...`);
      }
    }

    // 캐시 저장 (부분 성공도 저장)
    cache[groupIndex] = { players: best.players, pagesOk: best.pagesOk, isLast: best.isLast };
    saveGroupCache(cache);

    if (best.players.length === 0) {
      consecutiveEmptyGroups++;
      if (consecutiveEmptyGroups >= 2) {
        console.log(`  빈 그룹 ${consecutiveEmptyGroups}회 → 종료`);
        break;
      }
      continue;
    }
    consecutiveEmptyGroups = 0;

    console.log(`  → Group ${groupIndex + 1}: ${best.players.length}명 (${best.pagesOk}/5 pages)`);

    if (best.isLast) {
      console.log(`  마지막 그룹`);
      break;
    }
  }

  // 캐시에서 전체 결과 합산
  const all: { id: string; name: string; team: string; pos: string }[] = [];
  for (let g = 0; g < MAX_GROUPS; g++) {
    if (cache[g]?.players.length) all.push(...cache[g].players);
    if (cache[g]?.isLast) break;
  }
  return all;
}

// 전체 수비 기록 크롤링
export async function crawlDefense(): Promise<CrawledPlayer[]> {
  const url = `${BASE}/Record/Player/Defense/Basic.aspx`;
  console.log("=== KBO 수비 기록 크롤링 시작 ===\n");

  const all = await crawlCategory(url);

  console.log(`\n  수비 기록 총: ${all.length}행 (중복 포함)`);

  // 중복 제거 — 선수 한 명이 여러 포지션으로 등장 가능 (1B, OF 등)
  // 첫 번째 등장 포지션을 기준으로 (가장 많이 출장한 포지션이 먼저 나옴)
  const unique = new Map<string, { id: string; name: string; team: string; pos: string }>();
  for (const p of all) {
    if (!unique.has(p.id)) {
      unique.set(p.id, p);
    }
  }
  console.log(`  고유 선수: ${unique.size}명`);

  // 투수 기록도 추가로 수집 (수비 기록에 없는 투수 보완)
  console.log("\n[투수 기록 보완]");
  const pitcherUrl = `${BASE}/Record/Player/PitcherBasic/Basic1.aspx`;
  try {
    const pSession = await robustFetchWithCookies(pitcherUrl, { timeoutMs: 15000, retries: 3 });
    const pHtml = pSession.text;
    const pCookies = pSession.cookies;

    const $ = cheerio.load(pHtml);
    let pitchers: { id: string; name: string; team: string }[] = [];
    $("table.tData01 tbody tr").each((_, row) => {
      const cells = $(row).find("td");
      if (cells.length < 3) return;
      const link = $(cells[1]).find("a");
      const href = link.attr("href") || "";
      const m = href.match(/playerId=(\d+)/);
      if (!m) return;
      const name = link.text().trim();
      const team = $(cells[2]).text().trim();
      if (name && TEAM_MAP[team]) pitchers.push({ id: m[1], name, team: TEAM_MAP[team] });
    });

    // 투수도 페이지네이션 처리
    const pPages = getPageInfo(pHtml);
    let pCurrentHtml = pHtml;
    let pCurrentPage = 1;
    let pTotalPages = pPages.maxPage;

    while (pCurrentPage < pTotalPages) {
      for (let p = pCurrentPage + 1; p <= pTotalPages; p++) {
        const btnIdx = ((p - 1) % 5) + 1;
        const target = `ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$ucPager$btnNo${btnIdx}`;
        const body = buildPostback(pCurrentHtml, target);
        await new Promise((r) => setTimeout(r, 500));
        const res2 = await robustFetch(pitcherUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: pCookies,
            Referer: pitcherUrl,
          },
          body: body.toString(),
          timeoutMs: 15000,
          retries: 2,
        });
        pCurrentHtml = await res2.text();
        const $p = cheerio.load(pCurrentHtml);
        $p("table.tData01 tbody tr").each((_, row) => {
          const cells = $p(row).find("td");
          if (cells.length < 3) return;
          const link = $p(cells[1]).find("a");
          const href = link.attr("href") || "";
          const m = href.match(/playerId=(\d+)/);
          if (!m) return;
          const name = link.text().trim();
          const team = $p(cells[2]).text().trim();
          if (name && TEAM_MAP[team]) pitchers.push({ id: m[1], name, team: TEAM_MAP[team] });
        });
        pCurrentPage = p;
      }
      const nextInfo = getPageInfo(pCurrentHtml);
      if (nextInfo.hasNext) {
        const target = `ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$ucPager$btnNext`;
        const body = buildPostback(pCurrentHtml, target);
        await new Promise((r) => setTimeout(r, 500));
        const res3 = await robustFetch(pitcherUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: pCookies,
            Referer: pitcherUrl,
          },
          body: body.toString(),
          timeoutMs: 15000,
          retries: 2,
        });
        pCurrentHtml = await res3.text();
        const $p = cheerio.load(pCurrentHtml);
        $p("table.tData01 tbody tr").each((_, row) => {
          const cells = $p(row).find("td");
          if (cells.length < 3) return;
          const link = $p(cells[1]).find("a");
          const href = link.attr("href") || "";
          const m = href.match(/playerId=(\d+)/);
          if (!m) return;
          const name = link.text().trim();
          const team = $p(cells[2]).text().trim();
          if (name && TEAM_MAP[team]) pitchers.push({ id: m[1], name, team: TEAM_MAP[team] });
        });
        pCurrentPage++;
        pTotalPages = getPageInfo(pCurrentHtml).maxPage;
      } else {
        break;
      }
    }

    let addedPitchers = 0;
    for (const p of pitchers) {
      if (!unique.has(p.id)) {
        unique.set(p.id, { ...p, pos: "투수" });
        addedPitchers++;
      }
    }
    console.log(`  투수 기록에서 ${pitchers.length}명 발견, ${addedPitchers}명 추가`);
  } catch (e) {
    console.log("  투수 기록 보완 실패 (수비 기록만 사용):", e);
  }

  console.log(`\n최종 고유 선수: ${unique.size}명`);

  if (unique.size === 0) {
    console.error("선수를 한 명도 찾지 못했습니다. 크롤링 중단.");
    await sendTelegram(`🚨 <b>[crawl-defense] 크리티컬</b>\n선수 0명. KBO 사이트 점검 필요.`);
    return [];
  }
  if (unique.size < 100) {
    console.warn(`⚠️ 선수가 ${unique.size}명으로 비정상적으로 적습니다.`);
    await sendTelegram(`⚠️ <b>[crawl-defense] 경고</b>\n선수 ${unique.size}명 — 비정상적으로 적음.`);
  }

  console.log("상세 정보 수집 중...\n");

  // 상세 페이지에서 등번호, 투타 수집
  const entries = Array.from(unique.entries());
  const results: CrawledPlayer[] = [];
  const BATCH = 5;

  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(async ([id, p]) => {
        const d = await fetchDetail(id);
        const posInfo = POS_MAP[p.pos] || { position: p.pos, detail: null };
        return {
          name: p.name,
          team: p.team,
          position: posInfo.position,
          detailPosition: posInfo.detail,
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
  crawlDefense()
    .then((players) => {
      const outPath = "scripts/crawled-players-defense.json";
      writeFileSync(outPath, JSON.stringify(players, null, 2));
      console.log(`\n결과 저장: ${outPath} (${players.length}명)`);
    })
    .catch(async (e) => {
      console.error("크롤링 실패:", e);
      await sendTelegram(`🚨 <b>[crawl-defense] 실패</b>\n${String(e).substring(0, 200)}`);
      process.exit(1);
    });
}
