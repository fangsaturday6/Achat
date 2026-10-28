export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

// Sends through Resend's HTTP API. `from` must be on a domain verified in
// Resend, e.g. "Achat <login@achat.example.com>".
export class ResendMailer implements Mailer {
  constructor(
    private apiKey: string,
    private from: string,
  ) {}

  async send(to: string, subject: string, text: string): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [to], subject, text }),
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
  async send(to: string, subject: string, text: string): Promise<void> {
    console.log(`[achat mail] 给 ${to}：${subject}\n${text}`);
  }
}
