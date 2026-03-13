/**
 * 나무위키 링크 확인 스크립트 v2
 *
 * D1 기반: 로컬 DB 없이 프로덕션 API를 통해 선수 조회/업데이트.
 *
 * 차단 방지:
 * - 요청 간 4초 딜레이
 * - 10명마다 15초 배치 휴식
 * - 레이트 리밋 시 지수 백오프 (60초 → 120초 → 240초, 최대 3회)
 *
 * 검증 강화:
 * - 키워드 가중치 방식 (강한 키워드 +2, 포지션/스탯 +1, 소속팀 +4)
 * - 비야구 키워드 감점 (-3): 동명이인 방지
 * - confidence 등급 분류 (high/medium/low)
 * - high만 즉시 반영, medium/low는 2차 재검증 후 반영
 *
 * 사용법:
 *   npx tsx scripts/resolve-namuwiki.ts                    # 새 선수만 (프로덕션)
 *   npx tsx scripts/resolve-namuwiki.ts --recheck          # 전원 재검증
 *   npx tsx scripts/resolve-namuwiki.ts --verify           # 기존 URL 재검증만
 *   npx tsx scripts/resolve-namuwiki.ts --resume           # 중간결과 이어서 진행
 *   npx tsx scripts/resolve-namuwiki.ts http://localhost:3000  # 로컬 서버
 */
import { writeFileSync, readFileSync, existsSync } from "fs";
import "dotenv/config";

// === 설정 ===
const args = process.argv.slice(2);
const RECHECK = args.includes("--recheck");
const RESUME = args.includes("--resume");
const VERIFY_ONLY = args.includes("--verify");
const API_URL =
  args.find((a) => a.startsWith("http")) || "https://lineup.prmtwiki.com";
const SYNC_SECRET = process.env.SYNC_SECRET;

if (!SYNC_SECRET) {
  console.error("SYNC_SECRET이 .env에 설정되어 있지 않습니다.");
  process.exit(1);
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// === 타이밍 설정 (넉넉하게) ===
const REQUEST_DELAY_MS = 4000;
const BETWEEN_STEPS_DELAY_MS = 2000;
const BATCH_SIZE = 10;
const BATCH_REST_MS = 15000;
const RATE_LIMIT_BASE_MS = 60000;
const MAX_RATE_LIMIT_RETRIES = 3;

// === 배치 전송 설정 ===
const SYNC_BATCH_SIZE = 20; // API에 한번에 보낼 업데이트 수

const PROGRESS_FILE = "scripts/.namu-progress.json";

// === 야구 키워드 (가중치 포함) ===
const STRONG_KEYWORDS = [
  "KBO",
  "프로야구",
  "야구선수",
  "한국프로야구",
  "드래프트",
  "신인왕",
  "FA",
  "퓨처스리그",
  "1군",
  "2군",
];

const POSITION_KEYWORDS = [
  "투수",
  "타자",
  "포수",
  "유격수",
  "외야수",
  "내야수",
  "지명타자",
  "선발투수",
  "구원투수",
  "마무리투수",
];

const STAT_KEYWORDS = [
  "타율",
  "방어율",
  "홈런",
  "안타",
  "삼진",
  "세이브",
  "이닝",
  "타점",
  "도루",
  "출루율",
  "장타율",
  "OPS",
  "ERA",
  "WHIP",
  "WAR",
];

const TEAM_FULL_NAMES = [
  "KIA 타이거즈",
  "삼성 라이온즈",
  "LG 트윈스",
  "두산 베어스",
  "롯데 자이언츠",
  "한화 이글스",
  "키움 히어로즈",
  "SSG 랜더스",
  "NC 다이노스",
  "KT 위즈",
];

const TEAM_ALIASES: Record<string, string[]> = {
  KIA: ["KIA", "타이거즈", "기아"],
  삼성: ["삼성", "라이온즈"],
  LG: ["LG", "트윈스", "엘지"],
  KT: ["KT", "위즈", "케이티"],
  SSG: ["SSG", "랜더스", "에스에스지"],
  NC: ["NC", "다이노스", "엔씨"],
  두산: ["두산", "베어스"],
  키움: ["키움", "히어로즈", "넥센"],
  롯데: ["롯데", "자이언츠"],
  한화: ["한화", "이글스"],
};

const NON_BASEBALL_INDICATORS = [
  "배우",
  "가수",
  "아이돌",
  "드라마",
  "영화",
  "소설가",
  "정치인",
  "국회의원",
  "축구선수",
  "농구선수",
  "배구선수",
  "격투기",
];

interface Player {
  id: number;
  name: string;
  team: string;
  namuWikiUrl: string | null;
}

interface ProgressEntry {
  id: number;
  name: string;
  team: string;
  url: string | null;
  score: number;
  confidence: "high" | "medium" | "low" | "not_found";
  matchedPath: "disambig" | "direct" | "search" | null;
  verified: boolean;
}

// === API 헬퍼 ===
async function fetchPlayers(mode: string): Promise<Player[]> {
  const res = await fetch(`${API_URL}/api/sync-namu?mode=${mode}`, {
    headers: { "x-sync-secret": SYNC_SECRET! },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`선수 목록 조회 실패 (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.players;
}

async function syncNamuUrls(
  updates: { id: number; namuWikiUrl: string | null }[]
): Promise<{ updated: number; cleared: number }> {
  const res = await fetch(`${API_URL}/api/sync-namu`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-sync-secret": SYNC_SECRET!,
    },
    body: JSON.stringify({ updates }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`나무위키 URL 싱크 실패 (${res.status}): ${text}`);
  }
  return res.json();
}

// === 나무위키 페이지 fetch (지수 백오프) ===
async function fetchPage(url: string, retryCount = 0): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "ko-KR,ko;q=0.9",
      },
      redirect: "follow",
    });

    if (res.status === 404) return null;
    if (!res.ok) {
      console.log(`    [!] HTTP ${res.status} for ${url}`);
      return null;
    }

    const text = await res.text();

    if (
      text.includes("문서가 없습니다") ||
      text.includes("문서를 찾을 수 없습니다") ||
      text.includes("해당 문서를 찾을 수 없습니다")
    ) {
      return null;
    }

    if (
      text.includes("비정상적인 트래픽") ||
      text.includes("Too Many Requests")
    ) {
      if (retryCount >= MAX_RATE_LIMIT_RETRIES) {
        console.log(
          `    [!!] 레이트 리밋 ${MAX_RATE_LIMIT_RETRIES}회 초과, 건너뜀`
        );
        return null;
      }
      const waitMs = RATE_LIMIT_BASE_MS * Math.pow(2, retryCount);
      console.log(
        `    [!] 레이트 리밋 감지, ${waitMs / 1000}초 대기 (${retryCount + 1}/${MAX_RATE_LIMIT_RETRIES})...`
      );
      await sleep(waitMs);
      return fetchPage(url, retryCount + 1);
    }

    return text;
  } catch (e) {
    console.log(
      `    [!] 네트워크 오류: ${e instanceof Error ? e.message : e}`
    );
    return null;
  }
}

// === 점수 계산 (가중치 방식) ===
function scoreBaseball(
  html: string,
  team: string,
  playerName: string
): { score: number; details: string[] } {
  const details: string[] = [];
  let score = 0;

  for (const kw of STRONG_KEYWORDS) {
    if (html.includes(kw)) {
      score += 2;
      details.push(`강:${kw}`);
    }
  }

  for (const kw of POSITION_KEYWORDS) {
    if (html.includes(kw)) {
      score += 1;
      details.push(`포:${kw}`);
    }
  }

  for (const kw of STAT_KEYWORDS) {
    if (html.includes(kw)) {
      score += 1;
      details.push(`스:${kw}`);
    }
  }

  for (const tn of TEAM_FULL_NAMES) {
    if (html.includes(tn)) {
      score += 2;
      details.push(`팀전체:${tn}`);
      break;
    }
  }

  const aliases = TEAM_ALIASES[team] || [team];
  for (const alias of aliases) {
    if (html.includes(alias)) {
      score += 4;
      details.push(`소속팀:${alias}`);
      break;
    }
  }

  const nameCount = (html.match(new RegExp(playerName, "g")) || []).length;
  if (nameCount >= 3) {
    score += 3;
    details.push(`이름x${nameCount}`);
  }

  for (const anti of NON_BASEBALL_INDICATORS) {
    if (html.includes(anti)) {
      score -= 3;
      details.push(`비야구:-${anti}`);
    }
  }

  return { score, details };
}

function getConfidence(
  score: number,
  matchedPath: "disambig" | "direct" | "search"
): "high" | "medium" | "low" {
  if (matchedPath === "disambig") {
    if (score >= 8) return "high";
    if (score >= 3) return "medium";
    return "low";
  } else if (matchedPath === "search") {
    // 검색으로 찾은 경우: disambig과 동일 기준 (검색 결과 문서는 신뢰도 높음)
    if (score >= 8) return "high";
    if (score >= 3) return "medium";
    return "low";
  } else {
    if (score >= 15) return "high";
    if (score >= 8) return "medium";
    return "low";
  }
}

// === 나무위키 검색 (3단계용) ===
// "네일 KBO" 등으로 검색하여 검색 결과 페이지에서 문서 링크 추출
async function searchNamuWiki(
  query: string,
  team: string,
  playerName: string
): Promise<{
  url: string;
  score: number;
  details: string[];
} | null> {
  const searchUrl = `https://namu.wiki/search?q=${encodeURIComponent(query)}`;
  const html = await fetchPage(searchUrl);
  if (!html) return null;

  // 검색 결과에서 문서 링크 추출 (href="/w/..." 패턴)
  const linkPattern = /href="\/w\/([^"]+)"/g;
  const seen = new Set<string>();
  const candidates: string[] = [];
  let match;

  while ((match = linkPattern.exec(html)) !== null) {
    const decoded = decodeURIComponent(match[1]);
    // 검색 결과 중 선수 이름이 포함된 문서만 (최대 5개)
    if (!seen.has(decoded) && decoded.includes(playerName) && candidates.length < 5) {
      seen.add(decoded);
      candidates.push(decoded);
    }
  }

  // 각 후보 문서를 검증
  for (const docName of candidates) {
    const docUrl = `https://namu.wiki/w/${encodeURIComponent(docName)}`;

    await sleep(BETWEEN_STEPS_DELAY_MS);
    const docHtml = await fetchPage(docUrl);
    if (!docHtml) continue;

    const { score, details } = scoreBaseball(docHtml, team, playerName);
    if (score >= 3) {
      return { url: docUrl, score, details };
    }
  }

  return null;
}

// === 선수 해석 ===
async function resolvePlayer(
  name: string,
  team: string
): Promise<{
  url: string;
  score: number;
  confidence: "high" | "medium" | "low";
  matchedPath: "disambig" | "direct" | "search";
  details: string[];
} | null> {
  // 1단계: 이름(야구선수)
  const disambigName = `${name}(야구선수)`;
  const disambigUrl = `https://namu.wiki/w/${encodeURIComponent(disambigName)}`;
  const disambigHtml = await fetchPage(disambigUrl);

  if (disambigHtml) {
    const { score, details } = scoreBaseball(disambigHtml, team, name);
    if (score >= 1) {
      const confidence = getConfidence(score, "disambig");
      return {
        url: disambigUrl,
        score,
        confidence,
        matchedPath: "disambig",
        details,
      };
    }
  }

  await sleep(BETWEEN_STEPS_DELAY_MS);

  // 2단계: 이름 직접
  const directUrl = `https://namu.wiki/w/${encodeURIComponent(name)}`;
  const directHtml = await fetchPage(directUrl);

  if (directHtml) {
    const { score, details } = scoreBaseball(directHtml, team, name);
    if (score >= 6) {
      const confidence = getConfidence(score, "direct");
      return {
        url: directUrl,
        score,
        confidence,
        matchedPath: "direct",
        details,
      };
    }
  }

  await sleep(BETWEEN_STEPS_DELAY_MS);

  // 3단계: 나무위키 검색 (외국인/동명이인 대응)
  // "네일 KBO", "네일 야구선수" 등으로 검색
  const searchQueries = [`${name} KBO`, `${name} 야구 선수`];
  for (const q of searchQueries) {
    const searchResult = await searchNamuWiki(q, team, name);
    if (searchResult) {
      const confidence = getConfidence(searchResult.score, "search");
      return {
        url: searchResult.url,
        score: searchResult.score,
        confidence,
        matchedPath: "search",
        details: searchResult.details,
      };
    }
    await sleep(BETWEEN_STEPS_DELAY_MS);
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// === 중간 결과 저장/로드 ===
function saveProgress(entries: ProgressEntry[]) {
  writeFileSync(PROGRESS_FILE, JSON.stringify(entries, null, 2), "utf-8");
}

function loadProgress(): ProgressEntry[] | null {
  if (!existsSync(PROGRESS_FILE)) return null;
  try {
    return JSON.parse(readFileSync(PROGRESS_FILE, "utf-8"));
  } catch {
    return null;
  }
}

// === 배치로 DB 업데이트 플러시 ===
async function flushUpdates(
  pending: { id: number; namuWikiUrl: string | null }[]
) {
  if (pending.length === 0) return;

  for (let i = 0; i < pending.length; i += SYNC_BATCH_SIZE) {
    const batch = pending.slice(i, i + SYNC_BATCH_SIZE);
    try {
      const result = await syncNamuUrls(batch);
      console.log(
        `  [DB] ${batch.length}명 반영 (updated: ${result.updated}, cleared: ${result.cleared})`
      );
    } catch (e) {
      console.error(`  [DB] 반영 실패: ${e}`);
    }
  }
}

// === 메인 ===
async function main() {
  // API에서 선수 목록 가져오기
  const mode = RECHECK ? "all" : VERIFY_ONLY ? "verify" : "new";
  console.log(`\n${API_URL} 에서 선수 목록 조회 중 (mode: ${mode})...`);

  const players = await fetchPlayers(mode);

  console.log(`\n=== 나무위키 링크 확인 v2: ${players.length}명 ===`);
  console.log(
    `  모드: ${RECHECK ? "전원 재검증" : VERIFY_ONLY ? "기존 URL 재검증" : RESUME ? "이어서 진행" : "새 선수만"}`
  );
  console.log(
    `  딜레이: 요청간 ${REQUEST_DELAY_MS / 1000}초, 배치(${BATCH_SIZE}명)마다 ${BATCH_REST_MS / 1000}초 휴식`
  );
  console.log(`  대상 API: ${API_URL}`);
  console.log();

  if (players.length === 0) {
    console.log("처리할 선수가 없습니다.");
    return;
  }

  // VERIFY_ONLY 모드
  if (VERIFY_ONLY) {
    await verifyExistingUrls(players);
    return;
  }

  // 이전 진행 상태 로드
  let progress: ProgressEntry[] = [];
  const completedIds = new Set<number>();

  if (RESUME) {
    const saved = loadProgress();
    if (saved) {
      progress = saved;
      for (const e of saved) completedIds.add(e.id);
      console.log(`  [*] 이전 진행 ${saved.length}명 로드됨\n`);
    }
  }

  let found = 0;
  let skipped = 0;
  let notFound = 0;
  let processedInBatch = 0;
  const pendingUpdates: { id: number; namuWikiUrl: string | null }[] = [];

  for (let i = 0; i < players.length; i++) {
    const p = players[i];

    if (RESUME && completedIds.has(p.id)) {
      skipped++;
      continue;
    }

    const result = await resolvePlayer(p.name, p.team);
    const entry: ProgressEntry = {
      id: p.id,
      name: p.name,
      team: p.team,
      url: null,
      score: 0,
      confidence: "not_found",
      matchedPath: null,
      verified: false,
    };

    if (result) {
      entry.url = result.url;
      entry.score = result.score;
      entry.confidence = result.confidence;
      entry.matchedPath = result.matchedPath;

      const doc = decodeURIComponent(
        result.url.replace("https://namu.wiki/w/", "")
      );
      const tag =
        result.confidence === "high"
          ? "O"
          : result.confidence === "medium"
            ? "?"
            : "~";
      console.log(
        `  [${tag}] ${i + 1}/${players.length} ${p.name} (${p.team}) → ${doc} (score:${result.score}, ${result.confidence})`
      );

      // high confidence만 즉시 반영 대기열에 추가
      if (result.confidence === "high") {
        pendingUpdates.push({ id: p.id, namuWikiUrl: result.url });
        entry.verified = true;
      }
      found++;
    } else {
      // 기존 URL이 있었는데 못 찾음 → 2차 검증 대기
      if (p.namuWikiUrl) {
        console.log(
          `  [!] ${i + 1}/${players.length} ${p.name} (${p.team}) — 기존 URL 검증 실패 (2차 확인 대기)`
        );
      } else {
        console.log(
          `  [X] ${i + 1}/${players.length} ${p.name} (${p.team}) — 미등재`
        );
      }
      notFound++;
    }

    progress.push(entry);
    processedInBatch++;

    // 배치 휴식 + DB 플러시
    if (processedInBatch >= BATCH_SIZE && i < players.length - 1) {
      processedInBatch = 0;
      saveProgress(progress);
      await flushUpdates(pendingUpdates);
      pendingUpdates.length = 0;
      console.log(
        `\n  --- 배치 휴식 ${BATCH_REST_MS / 1000}초 (진행: ${i + 1}/${players.length}) ---\n`
      );
      await sleep(BATCH_REST_MS);
    } else if (i < players.length - 1) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  // 남은 업데이트 플러시
  await flushUpdates(pendingUpdates);
  pendingUpdates.length = 0;
  saveProgress(progress);

  // === 2차 검증: medium/low confidence 재확인 ===
  const needsVerification = progress.filter(
    (e) =>
      e.url &&
      !e.verified &&
      (e.confidence === "medium" || e.confidence === "low")
  );

  if (needsVerification.length > 0) {
    console.log(
      `\n=== 2차 검증: ${needsVerification.length}명 (medium/low confidence) ===`
    );
    console.log(`  30초 대기 후 시작...\n`);
    await sleep(30000);

    const verifiedUpdates: { id: number; namuWikiUrl: string | null }[] = [];

    for (let i = 0; i < needsVerification.length; i++) {
      const entry = needsVerification[i];
      console.log(
        `  재검증 ${i + 1}/${needsVerification.length}: ${entry.name} (${entry.team})`
      );

      const html = await fetchPage(entry.url!);
      if (html) {
        const { score } = scoreBaseball(html, entry.team, entry.name);

        const scoreDiff = Math.abs(score - entry.score);
        const stable = scoreDiff <= 2;

        if (
          stable &&
          score >= (entry.matchedPath === "disambig" ? 3 : 8)
        ) {
          verifiedUpdates.push({ id: entry.id, namuWikiUrl: entry.url });
          entry.verified = true;
          entry.score = score;
          console.log(`    → 확인됨 (score:${score}, 변동:${scoreDiff})`);
        } else {
          entry.url = null;
          entry.confidence = "not_found";
          console.log(
            `    → 탈락 (score:${score}, 변동:${scoreDiff}, 기준미달)`
          );
        }
      } else {
        entry.url = null;
        entry.confidence = "not_found";
        console.log(`    → 페이지 접근 불가, 탈락`);
      }

      if (i < needsVerification.length - 1) {
        await sleep(REQUEST_DELAY_MS);
      }

      if ((i + 1) % BATCH_SIZE === 0) {
        saveProgress(progress);
        await flushUpdates(verifiedUpdates);
        verifiedUpdates.length = 0;
        console.log(
          `\n  --- 2차 검증 배치 휴식 ${BATCH_REST_MS / 1000}초 ---\n`
        );
        await sleep(BATCH_REST_MS);
      }
    }

    await flushUpdates(verifiedUpdates);
  }

  // === 기존 URL 제거 대상 처리 ===
  const toRemoveFromDb = progress.filter(
    (e) => !e.url && e.confidence === "not_found"
  );
  const removeUpdates = players
    .filter((p) => p.namuWikiUrl && toRemoveFromDb.some((r) => r.id === p.id))
    .map((p) => ({ id: p.id, namuWikiUrl: null }));

  if (removeUpdates.length > 0) {
    console.log(`\n=== 기존 URL 제거: ${removeUpdates.length}명 ===`);
    await flushUpdates(removeUpdates);
  }

  // === 최종 리포트 ===
  const verified = progress.filter((e) => e.verified).length;
  const totalNotFound = progress.filter(
    (e) => e.confidence === "not_found"
  ).length;

  console.log(`\n${"=".repeat(50)}`);
  console.log(`=== 최종 결과 ===`);
  console.log(`  전체: ${players.length}명`);
  console.log(`  스킵: ${skipped}명`);
  console.log(`  확인: ${verified}명 (DB 업데이트 완료)`);
  console.log(`  미등재: ${totalNotFound}명`);
  console.log(`  URL 제거: ${removeUpdates.length}명`);
  console.log(`${"=".repeat(50)}`);

  // 미등재 선수 목록
  const notFoundPlayers = progress.filter(
    (e) => e.confidence === "not_found"
  );
  if (notFoundPlayers.length > 0) {
    console.log(`\n--- 미등재 선수 목록 ---`);
    const byTeam: Record<string, string[]> = {};
    for (const p of notFoundPlayers) {
      if (!byTeam[p.team]) byTeam[p.team] = [];
      byTeam[p.team].push(p.name);
    }
    for (const [team, names] of Object.entries(byTeam).sort()) {
      console.log(`  ${team}: ${names.join(", ")}`);
    }
  }

  saveProgress(progress);
  console.log(`\n진행 상태 저장: ${PROGRESS_FILE}`);
}

// === 기존 URL만 재검증 (--verify) ===
async function verifyExistingUrls(players: Player[]) {
  console.log(`\n=== 기존 URL 재검증: ${players.length}명 ===\n`);

  let valid = 0;
  let invalid = 0;
  const updates: { id: number; namuWikiUrl: string | null }[] = [];

  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!p.namuWikiUrl) continue;

    const html = await fetchPage(p.namuWikiUrl);
    if (html) {
      const { score } = scoreBaseball(html, p.team, p.name);
      const isDisambig = p.namuWikiUrl.includes("(야구선수)");
      const threshold = isDisambig ? 3 : 8;

      if (score >= threshold) {
        valid++;
        console.log(
          `  [O] ${i + 1}/${players.length} ${p.name} (${p.team}) — OK (score:${score})`
        );
      } else {
        invalid++;
        updates.push({ id: p.id, namuWikiUrl: null });
        console.log(
          `  [!] ${i + 1}/${players.length} ${p.name} (${p.team}) — 의심 (score:${score}) → 제거`
        );
      }
    } else {
      invalid++;
      updates.push({ id: p.id, namuWikiUrl: null });
      console.log(
        `  [X] ${i + 1}/${players.length} ${p.name} (${p.team}) — 페이지 없음 → 제거`
      );
    }

    if (i < players.length - 1) {
      await sleep(REQUEST_DELAY_MS);
    }

    if ((i + 1) % BATCH_SIZE === 0 && i < players.length - 1) {
      await flushUpdates(updates);
      updates.length = 0;
      console.log(
        `\n  --- 배치 휴식 ${BATCH_REST_MS / 1000}초 (${i + 1}/${players.length}) ---\n`
      );
      await sleep(BATCH_REST_MS);
    }
  }

  await flushUpdates(updates);
  console.log(`\n=== 재검증 완료: 유효 ${valid}, 제거 ${invalid} ===`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
