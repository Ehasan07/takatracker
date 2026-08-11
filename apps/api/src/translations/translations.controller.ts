import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { TranslationsService } from './translations.service';

const setSchema = z.object({
  locale: z.enum(['bn', 'en']),
  /** Null or empty puts the string back to what the build ships. */
  value: z.string().max(500).nullish(),
});

/**
 * The wording a workspace has corrected.
 *
 * Tenant-scoped like everything else: a correction belongs to the workspace
 * that made it and is never visible to another. There is no global override —
 * a wrong string that everybody should see fixed is a pull request, and one
 * household's preference is not everyone's.
 */
@Controller('translations')
@UseGuards(JwtAuthGuard)
export class TranslationsController {
  constructor(private readonly translations: TranslationsService) {}

  /** Fetched once at boot. Usually `{}`. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('locale') locale?: string) {
    return this.translations.forWorkspace(user.workspaceId, locale === 'en' ? 'en' : 'bn');
  }

  @Put(':key')
  set(
    @CurrentUser() user: AuthUser,
    @Param('key') key: string,
    @Body(zodPipe(setSchema)) body: z.infer<typeof setSchema>,
  ) {
    return this.translations.set(user, body.locale, key, body.value ?? null);
  }
}
