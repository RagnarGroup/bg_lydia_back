import { CommercialAuditService } from '@api/services/commercial-audit/commercial-audit.service';

// LYD-102: auditoria comercial diaria META K-01.
export class CommercialAuditController {
  constructor(private readonly service: CommercialAuditService) {}

  public startRun(date?: string) {
    return this.service.startRun(date);
  }

  public getRun(reportDate: string) {
    return this.service.getRun(reportDate);
  }

  public getRunHtml(reportDate: string) {
    return this.service.getRunHtml(reportDate);
  }

  public sendRun(reportDate: string, to?: unknown) {
    return this.service.sendRun(reportDate, to);
  }
}
