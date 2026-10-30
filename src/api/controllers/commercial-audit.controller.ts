import { CommercialAuditService } from '@api/services/commercial-audit/commercial-audit.service';

// LYD-102: auditoria comercial diaria META K-01. LYD-133: `version` elige la
// rubrica (K01-V1 o K01-V2.0); sin ella, la de la corrida automatica.
export class CommercialAuditController {
  constructor(private readonly service: CommercialAuditService) {}

  public startRun(date?: string, version?: unknown) {
    return this.service.startRun(date, version);
  }

  // LYD-117
  public startParticipation(reportDate: string, version?: unknown) {
    return this.service.startParticipation(reportDate, version);
  }

  public getRun(reportDate: string, version?: unknown) {
    return this.service.getRun(reportDate, version);
  }

  public getRunHtml(reportDate: string, version?: unknown) {
    return this.service.getRunHtml(reportDate, version);
  }

  public sendRun(reportDate: string, to?: unknown, version?: unknown) {
    return this.service.sendRun(reportDate, to, version);
  }
}
