/**
 * KBO 1군 등록 현황 크롤러
 *
 * /Player/RegisterAll.aspx 에서 전체 등록 선수 명단을 가져옴.
 * 시즌 중에만 데이터가 있음 (비시즌에는 일부 팀만 표시).
 *
 * 페이지 구조:
 * - table.tData.tDays > tbody > tr (팀별 행)
 * - th.fir: 팀 이름 (LG, 한화, SSG, ...)
 * - td[0]: 감독, td[1]: 코치, td[2]: 투수, td[3]: 포수, td[4]: 내야수, td[5]: 외야수
 * - 각 td 안에 <ul><li>이름(등번호)</li></ul>
 */
import * as cheerio from "cheerio";
import { robustFetch, robustFetchWithCookies, robustFetchText } from "./lib/http";
import { sendTelegram } from "./lib/telegram";

const BASE = "https://www.koreabaseball.com";
const REGISTER_URL = `${BASE}/Player/RegisterAll.aspx`;

// KBO 표시 팀명 → 우리 팀 ID 매핑
const TEAM_MAP: Record<string, string> = {
  LG: "LG", 한화: "한화", SSG: "SSG", 삼성: "삼성",
  NC: "NC", KT: "KT", 롯데: "롯데", KIA: "KIA",
  두산: "두산", 키움: "키움",
};

// 포지션 컬럼 인덱스 → 포지션명 (감독/코치는 제외)
const POS_COLUMNS: [number, string][] = [
  [3, "투수"],   // td index 2 (0-based after th)
  [4, "포수"],
  [5, "내야수"],
  [6, "외야수"],
];

export interface RegisteredPlayer {
  name: string;
  team: string;
  position: string;
  backNumber: number | null;
}

function parseRegisterPage(html: string): RegisteredPlayer[] {
  const $ = cheerio.load(html);
  const players: RegisteredPlayer[] = [];

  $("table.tDays tbody tr").each((_, row) => {
    const th = $(row).find("th.fir").text().trim();
    const teamId = TEAM_MAP[th];
    if (!teamId) return;

    const cells = $(row).find("td");

    for (const [colIdx, position] of POS_COLUMNS) {
      // colIdx is 1-based including th; cells is 0-based (td only)
      const tdIdx = colIdx - 1; // th는 cells에 안 들어감
      const cell = cells.eq(tdIdx);

      cell.find("li").each((_, li) => {
        const text = $(li).text().trim();
        // "이름(등번호)" 또는 "이름(등번호)*" (특별엔트리)
        const match = text.match(/^(.+?)\((\d+)\)\*?$/);
        if (!match) return;

        players.push({
          name: match[1],
          team: teamId,
          position,
          backNumber: parseInt(match[2]),
        });
      });
    }
  });

  return players;
}

export async function crawlRegisterAll(date?: string): Promise<{
  date: string;
  players: RegisteredPlayer[];
}> {
  let url = REGISTER_URL;

  // 날짜 지정 시 postback
  if (date) {
    // 초기 페이지 로드
    const { text: initHtml, cookies } = await robustFetchWithCookies(REGISTER_URL, { timeoutMs: 15000, retries: 3 });

    const $init = cheerio.load(initHtml);
    const fields: Record<string, string> = {};
    $init("input[type=hidden]").each((_, el) => {
      const name = $init(el).attr("name");
      const val = $init(el).val() as string;
      if (name) fields[name] = val || "";
    });

    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) body.set(k, v);
    body.set("ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$hfSearchDate", date);
    body.set("ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$btnSearch", "");

    const res = await robustFetch(REGISTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookies,
        Referer: REGISTER_URL,
      },
      body: body.toString(),
      timeoutMs: 15000,
      retries: 3,
    });

    const html = await res.text();
    const $page = cheerio.load(html);
    const pageDate = ($page("#cphContents_cphContents_cphContents_hfSearchDate").val() as string) || date;
    const players = parseRegisterPage(html);

    if (players.length === 0) {
      console.warn("⚠️ 파싱 결과 0명 — HTML 구조 변경 가능성 확인 필요");
      await sendTelegram(`🚨 <b>[crawl-register] 크리티컬</b>\n날짜 ${date} 파싱 결과 0명. HTML 구조 변경 가능성.`);
    }

    return { date: pageDate, players };
  }

  // 날짜 미지정: 기본 (최신 날짜)
  const html = await robustFetchText(url, { timeoutMs: 15000, retries: 3, minResponseSize: 500 });
  const $ = cheerio.load(html);
  const pageDate = ($("#cphContents_cphContents_cphContents_hfSearchDate").val() as string) || "unknown";
  const players = parseRegisterPage(html);

  if (players.length === 0) {
    console.warn("⚠️ 파싱 결과 0명 — HTML 구조 변경 가능성 확인 필요");
    await sendTelegram(`🚨 <b>[crawl-register] 크리티컬</b>\n파싱 결과 0명. HTML 구조 변경 가능성.`);
  }

  return { date: pageDate, players };
}

if (typeof require !== "undefined" && require.main === module) {
  const dateArg = process.argv[2]; // YYYYMMDD
  crawlRegisterAll(dateArg)
    .then(({ date, players }) => {
      console.log(`=== ${date} 1군 등록 현황 ===\n`);

      // 팀별 요약
      const teamCounts: Record<string, number> = {};
      for (const p of players) {
        teamCounts[p.team] = (teamCounts[p.team] || 0) + 1;
      }
      console.log("팀별 등록 선수:");
      for (const [team, count] of Object.entries(teamCounts).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${team}: ${count}명`);
      }
      console.log(`\n총 ${players.length}명`);
    })
    .catch((e) => { console.error("크롤링 실패:", e); process.exit(1); });
}
