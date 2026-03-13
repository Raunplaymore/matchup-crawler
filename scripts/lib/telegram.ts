/**
 * 공통 텔레그램 알림 유틸
 *
 * 환경변수 TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID가 설정되어 있을 때만 전송.
 * 알림 실패는 크롤링 자체에 영향을 주지 않음.
 */

const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

export async function sendTelegram(text: string): Promise<void> {
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
