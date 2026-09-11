import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdsService, type FooterAd } from './ads.service';

/**
 * `GET /v1/ads/footer` — what this workspace's printed documents carry.
 *
 * Every member may read it, whatever their role: it is what is already printed
 * on the page they are looking at, and a footer a viewer could not see would
 * mean the screen and the PDF disagreed about the same document.
 *
 * Returns `{ ad: null }` rather than a 404 when nothing runs. Most workspaces
 * have no sponsor and that is an answer, not a missing resource — a 404 here
 * would put an error in the console of every ordinary shop in the product.
 */
@Controller('ads')
@UseGuards(JwtAuthGuard)
export class AdsController {
  constructor(private readonly ads: AdsService) {}

  @Get('footer')
  async footer(@CurrentUser() user: AuthUser): Promise<{ ad: FooterAd | null }> {
    return { ad: await this.ads.footerFor(user.workspaceId) };
  }
}
