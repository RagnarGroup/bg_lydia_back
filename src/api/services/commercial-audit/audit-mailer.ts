import nodemailer, { Transporter } from 'nodemailer';

// LYD-102: envio del reporte por SMTP (en produccion, la cuenta soporte@ del
// SGA en el buzon de Banahost). Sin SMTP_HOST/SMTP_USER/SMTP_PASS no se envia
// nada y la corrida queda evaluada, consultable por la API.
export class AuditMailer {
  private transporter: Transporter | null = null;

  public isConfigured(): boolean {
    return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  }

  public recipients(): string[] {
    return splitList(process.env.COMMERCIAL_AUDIT_TO);
  }

  public alertRecipients(): string[] {
    const list = splitList(process.env.COMMERCIAL_AUDIT_ALERT_TO);
    return list.length ? list : this.recipients();
  }

  public async send(to: string[], subject: string, html: string): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error('Falta configurar SMTP_HOST, SMTP_USER y SMTP_PASS');
    }
    if (!to.length) {
      throw new Error('No hay destinatarios (COMMERCIAL_AUDIT_TO)');
    }
    const from = process.env.COMMERCIAL_AUDIT_FROM || `Lydia - Auditoria comercial <${process.env.SMTP_USER}>`;
    await this.getTransporter().sendMail({ from, to: to.join(', '), subject, html });
  }

  private getTransporter(): Transporter {
    if (!this.transporter) {
      const port = Number(process.env.SMTP_PORT || 587);
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: port === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
    }
    return this.transporter;
  }
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
