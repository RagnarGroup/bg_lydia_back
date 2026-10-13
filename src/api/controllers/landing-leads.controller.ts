import { LandingLeadCreateBody, LandingLeadsService } from '@api/services/landing-leads.service';

// LYD-83
export class LandingLeadsController {
  constructor(private readonly landingLeadsService: LandingLeadsService) {}

  public createFromLanding(body: LandingLeadCreateBody) {
    return this.landingLeadsService.createFromLanding(body);
  }

  public list(query: Parameters<LandingLeadsService['list']>[0]) {
    return this.landingLeadsService.list(query);
  }

  public summary() {
    return this.landingLeadsService.summary();
  }

  public getDetail(id: string) {
    return this.landingLeadsService.getDetail(id);
  }

  public claim(id: string, agentId: unknown) {
    return this.landingLeadsService.claim(id, agentId);
  }

  public release(id: string, agentId: unknown) {
    return this.landingLeadsService.release(id, agentId);
  }

  public updateVisit(id: string, body: Parameters<LandingLeadsService['updateVisit']>[1]) {
    return this.landingLeadsService.updateVisit(id, body);
  }

  public addNote(id: string, body: Parameters<LandingLeadsService['addNote']>[1]) {
    return this.landingLeadsService.addNote(id, body);
  }

  public changeStage(id: string, body: Parameters<LandingLeadsService['changeStage']>[1]) {
    return this.landingLeadsService.changeStage(id, body);
  }
}
