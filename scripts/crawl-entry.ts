/**
 * KBO 구단별 선수 등록 현황 크롤러
 *
 * /Player/Register.aspx 에서 구단별 탭 전환으로 전체 선수 정보를 수집.
 * 기존 crawl-players / crawl-roster보다 풍부한 정보를 상세 페이지 없이 수집 가능:
 *   등번호, 투타유형, 생년월일, 체격, 포지션, kboPlayerId
 *
 * 페이지 구조:
 * - div.teams > ul > li[data-id] (구단 탭, fnSearchChange 호출)
 * - table.tNData (포지션별: 투수, 포수, 내야수, 외야수)
 * - 각 행: 등번호 | 선수명(링크) | 투타유형 | 생년월일 | 체격
 * - 하단: 등/말소 현황 테이블
 */
import * as cheerio from "cheerio";

const BASE = "https://www.koreabaseball.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const REGISTER_URL = `${BASE}/Player/Register.aspx`;

// KBO 팀 코드 → 우리 팀 ID
const TEAM_CODES: [string, string][] = [
  ["OB", "두산"],
  ["LT", "롯데"],
  ["SS", "삼성"],
  ["WO", "키움"],
  ["HH", "한화"],
  ["HT", "KIA"],
  ["KT", "KT"],
  ["LG", "LG"],
  ["NC", "NC"],
  ["SK", "SSG"],
];

// 포지션 헤더 → [position, detailPosition]
const POS_HEADER_MAP: Record<string, [string, string | null]> = {
  투수: ["투수", null],  // detailPosition은 링크 패턴으로 보강
  포수: ["포수", "C"],
  내야수: ["내야수", null],
  외야수: ["외야수", null],
};

export interface EntryPlayer {
  name: string;
  team: string;
  position: string;
  detailPosition: string | null;
  backNumber: number | null;
  bats: string | null;
  throws: string | null;
  kboPlayerId: string;
  birthDate: string | null;
  height: number | null;
  weight: number | null;
}

export interface EntryChange {
  name: string;
  team: string;
  position: string;
  backNumber: number | null;
  type: "등록" | "말소";
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

// 포지션별 테이블 파싱
function parseTeamPage(html: string, teamId: string): {
  players: EntryPlayer[];
  changes: EntryChange[];
} {
  const $ = cheerio.load(html);
  const players: EntryPlayer[] = [];
  const changes: EntryChange[] = [];

  const tables = $("table.tNData");

  tables.each((idx, table) => {
    const headers = $(table).find("thead th");
    if (headers.length === 0) return;

    // 포지션 헤더 (두 번째 th에 "투수", "포수", "내야수", "외야수" 또는 "선수명")
    const posHeader = $(headers[1]).text().trim();

    // 등/말소 현황 테이블 감지 (포지션 컬럼이 있는 경우)
    const isChangeTable = headers.toArray().some(h => $(h).text().trim() === "포지션");

    if (isChangeTable) {
      // 등/말소 현황 파싱
      $(table).find("tbody tr").each((_, row) => {
        const cells = $(row).find("td");
        if (cells.length < 4) return;
        // colspan 체크 (데이터 없음 표시)
        if ($(cells[0]).attr("colspan")) return;

        const backNum = parseInt($(cells[0]).text().trim());
        const name = $(cells[1]).text().trim();
        const position = $(cells[2]).text().trim();

        if (name) {
          // 테이블 제목으로 등록/말소 구분 — 이전 형제 요소 확인
          // 등록 테이블이 먼저, 말소 테이블이 나중
          const sectionTitle = $(table).prevAll("h6, .sub_tit, strong").first().text().trim();
          const type = sectionTitle.includes("말소") ? "말소" as const : "등록" as const;

          changes.push({
            name,
            team: teamId,
            position,
            backNumber: isNaN(backNum) ? null : backNum,
            type,
          });
        }
      });
      return;
    }

    // 일반 선수 테이블 파싱
    const posMapping = POS_HEADER_MAP[posHeader];
    if (!posMapping) return;

    const [position, defaultDetailPos] = posMapping;

    $(table).find("tbody tr").each((_, row) => {
      const cells = $(row).find("td");
      if (cells.length < 5) return;
      if ($(cells[0]).attr("colspan")) return;

      // 등번호
      const backNumText = $(cells[0]).text().trim();
      const backNumber = parseInt(backNumText);

      // 선수명 + playerId
      const link = $(cells[1]).find("a");
      const name = link.text().trim();
      const href = link.attr("href") || "";
      const idMatch = href.match(/playerId=(\d+)/);
      if (!name || !idMatch) return;

      const kboPlayerId = idMatch[1];
      const isPitcher = href.includes("PitcherDetail");

      // 투타유형
      let bats: string | null = null;
      let throws_: string | null = null;
      const btText = $(cells[2]).text().trim();
      // "우투우타", "좌투좌타", "우언우타" 등
      const btMatch = btText.match(/(좌|우)(투|언)(좌|우|양)(타)/);
      if (btMatch) {
        throws_ = btMatch[1];
        bats = btMatch[3];
      }

      // 생년월일
      const birthDate = $(cells[3]).text().trim() || null;

      // 체격
      let height: number | null = null;
      let weight: number | null = null;
      const bodyText = $(cells[4]).text().trim();
      const bodyMatch = bodyText.match(/(\d+)cm,?\s*(\d+)kg/);
      if (bodyMatch) {
        height = parseInt(bodyMatch[1]);
        weight = parseInt(bodyMatch[2]);
      }

      // detailPosition 결정
      let detailPosition = defaultDetailPos;
      if (isPitcher) {
        detailPosition = "SP"; // 기본값, 추후 보강 가능
      }

      players.push({
        name,
        team: teamId,
        position,
        detailPosition,
        backNumber: isNaN(backNumber) ? null : backNumber,
        bats,
        throws: throws_,
        kboPlayerId,
        birthDate,
        height,
        weight,
      });
    });
  });

  return { players, changes };
}

export async function crawlEntry(targetTeam?: string): Promise<{
  date: string;
  players: EntryPlayer[];
  changes: EntryChange[];
}> {
  console.log("=== KBO 구단별 선수 등록 현황 크롤링 ===\n");

  // 1. 초기 페이지 로드
  console.log("초기 페이지 로드...");
  const initRes = await fetch(REGISTER_URL, { headers: { "User-Agent": UA } });
  const initHtml = await initRes.text();
  const cookies = initRes.headers.getSetCookie?.().join("; ") || "";
  let fields = extractHiddenFields(initHtml);

  const $init = cheerio.load(initHtml);
  const pageDate = ($init("#cphContents_cphContents_cphContents_hfSearchDate").val() as string) || "unknown";
  console.log(`날짜: ${pageDate}\n`);

  const allPlayers: EntryPlayer[] = [];
  const allChanges: EntryChange[] = [];

  // 필터링: 특정 팀만
  const teams = targetTeam
    ? TEAM_CODES.filter(([_, id]) => id === targetTeam)
    : TEAM_CODES;

  // 첫 번째 팀 (기본 로드된 팀)은 postback 없이 파싱
  const defaultTeamCode = ($init("#cphContents_cphContents_cphContents_hfSearchTeam").val() as string) || "OB";
  const defaultTeamEntry = TEAM_CODES.find(([code]) => code === defaultTeamCode);

  for (const [code, teamId] of teams) {
    console.log(`[${teamId}] 크롤링 중...`);

    let html: string;

    if (code === defaultTeamCode && !targetTeam) {
      // 기본 로드된 팀 — 바로 파싱
      html = initHtml;
    } else {
      // 팀 전환 postback
      await new Promise((r) => setTimeout(r, 2000));

      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(fields)) {
        body.set(k, v);
      }
      body.set("__EVENTTARGET", "");
      body.set("__EVENTARGUMENT", "");
      body.set("ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$hfSearchTeam", code);
      body.set("ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$hfSearchDate", pageDate);
      body.set("ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$btnTeamSearch", "");

      const res = await fetch(REGISTER_URL, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookies,
          Referer: REGISTER_URL,
        },
        body: body.toString(),
      });
      html = await res.text();
      fields = extractHiddenFields(html);
    }

    const { players, changes } = parseTeamPage(html, teamId);
    console.log(`  선수 ${players.length}명, 등/말소 ${changes.length}건`);
    allPlayers.push(...players);
    allChanges.push(...changes);
  }

  console.log(`\n=== 크롤링 완료: ${allPlayers.length}명, 등/말소 ${allChanges.length}건 ===`);
  return { date: pageDate, players: allPlayers, changes: allChanges };
}

if (require.main === module) {
  const teamArg = process.argv[2]; // 특정 팀만: "LG", "두산" 등

  crawlEntry(teamArg)
    .then(({ date, players, changes }) => {
      console.log(`\n날짜: ${date}`);

      // 팀별 요약
      const teamCounts: Record<string, number> = {};
      for (const p of players) {
        teamCounts[p.team] = (teamCounts[p.team] || 0) + 1;
      }
      console.log("\n팀별 등록 선수:");
      for (const [team, count] of Object.entries(teamCounts).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${team}: ${count}명`);
      }
      console.log(`\n총 ${players.length}명`);

      if (changes.length > 0) {
        console.log("\n등/말소 현황:");
        for (const c of changes) {
          console.log(`  [${c.type}] ${c.team} ${c.name} (${c.position}, #${c.backNumber})`);
        }
      }

      // JSON 출력 (파이프라인 활용)
      if (process.argv.includes("--json")) {
        console.log(JSON.stringify({ date, players, changes }, null, 2));
      }
    })
    .catch((e) => {
      console.error("크롤링 실패:", e);
      process.exit(1);
    });
}
