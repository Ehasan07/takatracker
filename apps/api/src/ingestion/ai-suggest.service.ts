import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UsageMeterService } from '../entitlements/usage-meter.service';
import { EntitlementsService } from '../entitlements/entitlements.service';

/**
 * A model proposing the category and the account a draft belongs to.
 *
 * ## Why a model at all, when there is a parser
 *
 * The parser reads what the string says: an amount, a date, a direction, a
 * balance. It cannot know that "স্বপ্ন" is a supermarket, that "UCBL ATM" is a
 * cash withdrawal from the account ending 0570, or that a message naming a
 * school is probably education. That is knowledge about the world rather than
 * about the text, and no amount of regular expression buys it.
 *
 * So the split is: the parser does arithmetic and the model does judgement,
 * and neither is allowed to do the other's job. Nothing here touches an amount,
 * a date or a direction — if a model were allowed to adjust a figure this would
 * be a very different piece of software and a much worse one.
 *
 * ## It suggests; the person decides
 *
 * The draft stays a draft. The fields arrive filled in and every one of them is
 * editable, and `suggestedBy` records which model filled them so the review
 * screen can say so. A suggestion presented as a reading is how people stop
 * checking, and the whole product rests on somebody checking.
 *
 * ## Every failure is silent
 *
 * No key, no quota, model down, model returns nonsense, model names a category
 * from another workspace — all of it ends with the draft exactly as the parser
 * left it. This feature makes drafts better; it must never be able to stop one
 * existing. That is why nothing in here throws.
 *
 * ## What leaves the server, and whose choice that is
 *
 * The message text and the workspace's category and account *names*. No
 * balances, no other transactions, no identity — but the text of somebody's
 * bank SMS is theirs, and sending it to a third party is a decision they should
 * take rather than discover. `Workspace.aiSuggestEnabled` is off by default and
 * this returns immediately when it is.
 */

/** What the model is asked to return, and the only shape accepted back. */
interface Suggestion {
  categoryId: string | null;
  accountId: string | null;
  confidence: number;
}

/** Rough, and deliberately so — see `meter`. */
const CHARS_PER_TOKEN = 4;

@Injectable()
export class AiSuggestService {
  private readonly logger = new Logger(AiSuggestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meters: UsageMeterService,
    private readonly entitlements: EntitlementsService,
  ) {}

  private get key(): string {
    return process.env.AI_SUGGEST_API_KEY ?? '';
  }

  /** OpenAI by default; any OpenAI-compatible endpoint by configuration. */
  private get baseUrl(): string {
    return process.env.AI_SUGGEST_BASE_URL ?? 'https://api.openai.com/v1';
  }

  private get model(): string {
    return process.env.AI_SUGGEST_MODEL ?? 'gpt-4o-mini';
  }

  /**
   * Fill in a draft's category and account, if everything lines up.
   *
   * Returns quietly the moment anything does not: no key, the workspace has not
   * asked for it, the plan has no AI allowance left, the draft has no message.
   */
  async suggestForDraft(workspaceId: string, draftId: string): Promise<void> {
    if (!this.key) return;

    try {
      const workspace = await this.prisma.workspace.findFirst({
        where: { id: workspaceId, deletedAt: null },
        select: { aiSuggestEnabled: true, timezone: true, locale: true },
      });
      if (!workspace?.aiSuggestEnabled) return;

      /* The plan's own AI allowance. Free is zero, which is the whole gate: a
         workspace that has not paid for this cannot spend the owner's tokens. */
      const allowed = await this.entitlements
        .assertWithinLimit(workspaceId, 'ai.tokens.monthly.max', workspace.timezone)
        .then(() => true)
        .catch(() => false);
      if (!allowed) return;

      const draft = await this.prisma.transactionDraft.findFirst({
        where: { id: draftId, workspaceId, status: 'PENDING' },
        select: {
          id: true,
          direction: true,
          categoryId: true,
          accountId: true,
          message: { select: { body: true, sender: true } },
        },
      });
      if (!draft?.message?.body) return;
      /* Already filled in — by the parser, or by a person who got there first.
         Overwriting somebody's choice with a guess is the one thing this must
         never do. Each field is guarded on its own: the account is now often
         known from the message's own account number before this runs, and that
         is no reason to leave the category blank. */
      if (draft.categoryId && draft.accountId) return;

      const [categories, accounts] = await Promise.all([
        this.prisma.category.findMany({
          where: {
            workspaceId,
            deletedAt: null,
            kind: draft.direction === 'IN' ? 'INCOME' : 'EXPENSE',
          },
          select: { id: true, name: true, nameBn: true },
          take: 100,
        }),
        this.prisma.account.findMany({
          where: { workspaceId, deletedAt: null, isArchived: false, systemKey: null },
          select: { id: true, name: true },
          take: 50,
        }),
      ]);
      if (categories.length === 0 || accounts.length === 0) return;

      const prompt = AiSuggestService.buildPrompt(
        draft.message.body,
        draft.message.sender,
        categories,
        accounts,
      );

      const suggestion = await this.ask(prompt);
      if (!suggestion) return;

      /* Never trust an id a model produced. It can hallucinate a plausible cuid,
         and one from another workspace would be a cross-tenant write dressed up
         as a helpful guess. Only ids from the lists just sent are accepted. */
      const categoryId = categories.some((c) => c.id === suggestion.categoryId)
        ? suggestion.categoryId
        : null;
      const accountId = accounts.some((a) => a.id === suggestion.accountId)
        ? suggestion.accountId
        : null;

      /* Only the fields that were empty when this started. A model asked for
         both always answers both, and writing the account it chose over one
         read from the message's own account number would replace a fact with
         a guess. */
      const data: { categoryId?: string; accountId?: string } = {};
      if (!draft.categoryId && categoryId) data.categoryId = categoryId;
      if (!draft.accountId && accountId) data.accountId = accountId;
      if (data.categoryId === undefined && data.accountId === undefined) return;

      await this.prisma.transactionDraft.updateMany({
        /* `updateMany` with the same guards the read used: a person may have
           accepted or edited this draft in the seconds the model took. Each
           field is guarded only if it is one being written. */
        where: {
          id: draftId,
          workspaceId,
          status: 'PENDING',
          ...(data.categoryId === undefined ? {} : { categoryId: null }),
          ...(data.accountId === undefined ? {} : { accountId: null }),
        },
        data: { ...data, suggestedBy: this.model },
      });

      await this.meter(workspaceId, workspace.timezone, prompt);
    } catch (err) {
      /* Deliberately swallowed. A draft that exists with three fields filled in
         is worth more than no draft at all, and this feature is not allowed to
         be the reason one goes missing. */
      this.logger.warn(`Suggestion failed for draft ${draftId}: ${(err as Error).message}`);
    }
  }

  /**
   * The prompt.
   *
   * Names and ids, and the message. No balances, no history, no other
   * transactions — a classifier needs the thing being classified and the labels
   * available, and anything beyond that is somebody's private data sent to a
   * third party for no gain.
   */
  private static buildPrompt(
    body: string,
    sender: string | null,
    categories: { id: string; name: string; nameBn: string | null }[],
    accounts: { id: string; name: string }[],
  ): string {
    const categoryList = categories
      .map((c) => `${c.id}\t${[c.nameBn, c.name].filter(Boolean).join(' / ')}`)
      .join('\n');
    const accountList = accounts.map((a) => `${a.id}\t${a.name}`).join('\n');

    return [
      'You are classifying one Bangladeshi bank or wallet SMS for a personal',
      'accounting app. Choose the best category and the account the money moved',
      'through, from the lists below. Use only ids from the lists.',
      '',
      'Reply with JSON only, no prose:',
      '{"categoryId":"…","accountId":"…","confidence":0-100}',
      '',
      'Use null for either field you cannot choose with reason. A wrong guess',
      'costs the person a correction; a null costs them one tap. Prefer null.',
      '',
      `Message from ${sender ?? 'unknown sender'}:`,
      body.slice(0, 1000),
      '',
      'Categories (id, name):',
      categoryList,
      '',
      'Accounts (id, name):',
      accountList,
    ].join('\n');
  }

  /** One request, short timeout, strict JSON out or nothing. */
  private async ask(prompt: string): Promise<Suggestion | null> {
    const controller = new AbortController();
    /* Eight seconds. The draft is already saved and the person is not waiting
       on this; a model having a slow day must not hold a webhook open. */
    const timer = setTimeout(() => controller.abort(), 8_000);

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.key}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) return null;

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = data.choices?.[0]?.message?.content;
      if (!text) return null;

      const parsed = JSON.parse(text) as Partial<Suggestion>;
      return {
        categoryId: typeof parsed.categoryId === 'string' ? parsed.categoryId : null,
        accountId: typeof parsed.accountId === 'string' ? parsed.accountId : null,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Charge the workspace's AI allowance.
   *
   * Estimated from the prompt length rather than read from the response, and
   * that is a deliberate approximation: the exact count is in the API's reply
   * and using it would mean a workspace whose request failed halfway is charged
   * nothing while one whose reply was long is charged twice over. Characters
   * over four is close enough to stop runaway spending, which is the only thing
   * this meter is for.
   */
  private async meter(workspaceId: string, timezone: string, prompt: string): Promise<void> {
    const tokens = Math.ceil(prompt.length / CHARS_PER_TOKEN);
    await this.meters
      .increment(workspaceId, 'ai.tokens.monthly.max', tokens, timezone)
      .catch(() => undefined);
  }
}
