import https from "https";

const BOT_TOKEN = "8759462582:AAFdF0JLLG8UyEIscFL1p_twlc4LlWaXUp8";
const CHAT_ID = "8626397840";

/**
 * Send a Telegram notification to the admin.
 * Fire-and-forget — never throws or blocks the bot.
 */
export function notify(message: string): void {
  try {
    const payload = JSON.stringify({
      chat_id: CHAT_ID,
      text: message,
      parse_mode: "Markdown"
    });

    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      () => {} // ignore response
    );
    req.on("error", () => {}); // ignore errors silently
    req.write(payload);
    req.end();
  } catch {
    // never crash the bot for a notification failure
  }
}
