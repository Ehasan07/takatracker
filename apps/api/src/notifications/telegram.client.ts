import { Injectable, Logger } from '@nestjs/common';

/**
 * A thin Telegram Bot API client.
 *
 * The only place a bot token is ever read. It never appears in a log line, an
 * error message or a thrown payload — `redactToken` scrubs it from any URL that
 * leaks into a message, because the API puts the token in the path.
 */

export interface TelegramSendResult {
  ok: boolean;
  /** Set when Telegram refused for a reason worth acting on. */
  failure?: 'BLOCKED' | 'BAD_CHAT' | 'RATE_LIMITED' | 'AUTH' | 'UNKNOWN';
  retryAfterSeconds?: number;
  description?: string;
}

export interface InlineButton {
  text: string;
  callbackData: string;
}

const API_ROOT = 'https://api.telegram.org';

/** Telegram embeds the token in the URL, so any leaked URL leaks the secret. */
export function redactToken(text: string): string {
  return text.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***');
}

@Injectable()
export class TelegramClient {
  private readonly logger = new Logger(TelegramClient.name);

  /** The official Hishab bot, from the server's secret store. */
  get sharedBotToken(): string | undefined {
    return process.env.TELEGRAM_BOT_TOKEN || undefined;
  }

  get sharedBotUsername(): string | undefined {
    return process.env.TELEGRAM_BOT_USERNAME || undefined;
  }

  private async call<T>(
    token: string,
    method: string,
    body: Record<string, unknown>,
  ): Promise<{
    ok: boolean;
    result?: T;
    error_code?: number;
    description?: string;
    parameters?: { retry_after?: number };
  }> {
    const res = await fetch(`${API_ROOT}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return (await res.json()) as never;
  }

  async sendMessage(
    token: string,
    chatId: string,
    text: string,
    buttons: InlineButton[] = [],
  ): Promise<TelegramSendResult> {
    try {
      const payload: Record<string, unknown> = {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      };
      if (buttons.length > 0) {
        payload.reply_markup = {
          inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.callbackData }))],
        };
      }

      const json = await this.call<unknown>(token, 'sendMessage', payload);
      if (json.ok) return { ok: true };

      return { ok: false, ...TelegramClient.classify(json), description: json.description };
    } catch (err) {
      // A network error is transient; do not disable the connection for it.
      this.logger.warn(`Telegram send failed: ${redactToken((err as Error).message)}`);
      return { ok: false, failure: 'UNKNOWN' };
    }
  }

  async answerCallback(token: string, callbackQueryId: string, text: string): Promise<void> {
    await this.call(token, 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
    }).catch(() => undefined);
  }

  async setWebhook(token: string, url: string, secretToken: string): Promise<boolean> {
    const json = await this.call<unknown>(token, 'setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message', 'callback_query'],
    });
    if (!json.ok) {
      this.logger.error(`setWebhook refused: ${json.description ?? 'unknown'}`);
    }
    return json.ok;
  }

  /**
   * 403 means the user blocked the bot and 400 usually means the chat id is
   * wrong — both are permanent and must stop the sending, not be retried. 429
   * carries its own backoff. 401 means our token is dead.
   */
  private static classify(json: {
    error_code?: number;
    parameters?: { retry_after?: number };
  }): Pick<TelegramSendResult, 'failure' | 'retryAfterSeconds'> {
    switch (json.error_code) {
      case 401:
      case 404:
        return { failure: 'AUTH' };
      case 403:
        return { failure: 'BLOCKED' };
      case 400:
        return { failure: 'BAD_CHAT' };
      case 429:
        return { failure: 'RATE_LIMITED', retryAfterSeconds: json.parameters?.retry_after ?? 30 };
      default:
        return { failure: 'UNKNOWN' };
    }
  }
}
