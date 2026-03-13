/**
 * 공통 HTTP 유틸리티
 *
 * KBO 사이트 크롤링에 특화된 재시도, 429 감지, timeout 지원.
 * 모든 크롤링 스크립트에서 이 모듈을 사용하여 일관된 에러 처리를 보장.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

const RATE_LIMIT_PATTERNS = [
  "Too Many Requests",
  "비정상적인 트래픽",
  "Access Denied",
  "rate limit",
];

export interface FetchOptions extends RequestInit {
  /** 요청 제한 시간 (ms). 기본 30000 */
  timeoutMs?: number;
  /** 최대 재시도 횟수. 기본 3 */
  retries?: number;
  /** 기본 재시도 대기 (ms). 기본 2000 */
  retryDelayMs?: number;
  /** 응답 최소 크기 (bytes). 이보다 작으면 에러 페이지로 간주. 기본 0 (비활성) */
  minResponseSize?: number;
  /** 응답에 포함되어야 하는 문자열 (HTML 검증용) */
  expectInResponse?: string;
}

export class RateLimitError extends Error {
  constructor(
    message: string,
    public retryAfterMs: number
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class ResponseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponseValidationError";
  }
}

function isRateLimited(status: number, body: string): boolean {
  if (status === 429) return true;
  if (status === 403) {
    return RATE_LIMIT_PATTERNS.some((p) => body.includes(p));
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * timeout + 재시도 + 429 감지가 내장된 fetch.
 * 모든 크롤러에서 bare fetch() 대신 사용.
 */
export async function robustFetch(
  url: string,
  options: FetchOptions = {}
): Promise<Response> {
  const {
    timeoutMs = 30000,
    retries = 3,
    retryDelayMs = 2000,
    minResponseSize,
    expectInResponse,
    ...fetchOpts
  } = options;

  // 기본 User-Agent 설정
  const headers = new Headers(fetchOpts.headers);
  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", UA);
  }
  fetchOpts.headers = headers;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...fetchOpts,
        signal: controller.signal,
      });
      clearTimeout(timer);

      // 429 / rate limit 감지
      if (res.status === 429 || res.status === 403) {
        const body = await res.text();
        if (isRateLimited(res.status, body)) {
          const waitMs = Math.min(60000 * attempt, 240000); // 60s → 120s → 240s
          console.warn(
            `  ⚠️ Rate limit 감지 (${res.status}), ${waitMs / 1000}초 대기... [${attempt}/${retries}]`
          );
          if (attempt < retries) {
            await sleep(waitMs);
            continue;
          }
          throw new RateLimitError(
            `Rate limit ${retries}회 초과`,
            waitMs
          );
        }
      }

      // 5xx 서버 에러
      if (res.status >= 500) {
        if (attempt < retries) {
          console.warn(
            `  HTTP ${res.status}, 재시도 ${attempt}/${retries}...`
          );
          await sleep(retryDelayMs * attempt);
          continue;
        }
        throw new Error(`HTTP ${res.status} after ${retries} retries`);
      }

      // 4xx (429/403 제외)
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${url}`);
      }

      return res;
    } catch (e: unknown) {
      clearTimeout(timer);

      // AbortError = timeout
      if (e instanceof DOMException && e.name === "AbortError") {
        if (attempt < retries) {
          console.warn(
            `  Timeout (${timeoutMs}ms), 재시도 ${attempt}/${retries}...`
          );
          await sleep(retryDelayMs * attempt);
          continue;
        }
        throw new Error(`Timeout after ${retries} retries: ${url}`);
      }

      // RateLimitError는 그대로 throw
      if (e instanceof RateLimitError) throw e;

      // 네트워크 에러
      if (attempt < retries) {
        console.warn(
          `  네트워크 에러, 재시도 ${attempt}/${retries}: ${e}`
        );
        await sleep(retryDelayMs * attempt);
        continue;
      }
      throw e;
    }
  }

  throw new Error(`Unreachable: ${url}`);
}

/**
 * robustFetch + text 반환 + 응답 검증.
 * HTML 크롤링에 적합.
 */
export async function robustFetchText(
  url: string,
  options: FetchOptions = {}
): Promise<string> {
  const { minResponseSize = 0, expectInResponse, ...rest } = options;
  const res = await robustFetch(url, rest);
  const text = await res.text();

  if (minResponseSize > 0 && text.length < minResponseSize) {
    throw new ResponseValidationError(
      `응답이 너무 짧음 (${text.length} bytes < ${minResponseSize}): ${url}`
    );
  }

  if (expectInResponse && !text.includes(expectInResponse)) {
    throw new ResponseValidationError(
      `응답에 "${expectInResponse}" 없음 — 에러 페이지일 수 있음: ${url}`
    );
  }

  return text;
}

/**
 * robustFetch + cookies 추출.
 * ASP.NET 세션 초기화에 사용.
 */
export async function robustFetchWithCookies(
  url: string,
  options: FetchOptions = {}
): Promise<{ text: string; cookies: string; response: Response }> {
  const res = await robustFetch(url, options);
  const cookies = res.headers.getSetCookie?.().join("; ") || "";
  const text = await res.text();
  return { text, cookies, response: res };
}
