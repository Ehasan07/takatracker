import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuditService } from './audit.service';

/**
 * Read-only by design. The log is append-only, so there is deliberately no
 * endpoint that can edit or delete an entry.
 */
@Controller('audit')
@UseGuards(JwtAuthGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('action') action?: string,
    @Query('entityId') entityId?: string,
  ) {
    return this.audit.list(user.workspaceId, {
      limit: limit ? Number(limit) : undefined,
      cursor,
      action,
      entityId,
    });
  }
}
