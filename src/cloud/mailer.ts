import type { Email } from "./emails.js";

export interface Mailer {
  send(email: Email): Promise<void>;
}

// Sends through Resend's HTTP API. `from` must be on a domain verified in
// Resend, e.g. "Achat <login@achat.example.com>".
export class ResendMailer implements Mailer {
  constructor(
    private apiKey: string,
    private from: string,
  ) {}

  async send(email: Email): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [email.to], subject: email.subject, text: email.text, html: email.html }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Resend 发信失败（HTTP ${res.status}）：${detail.slice(0, 200)}`);
    }
  }
}

// Prints mail to the server log instead of sending it, for trying the server
// out before email is set up.
export class ConsoleMailer implements Mailer {
  async send(email: Email): Promise<void> {
    console.log(`[achat mail] 给 ${email.to}：${email.subject}\n${email.text}`);
  }
}
