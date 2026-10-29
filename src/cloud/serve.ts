import { join } from "node:path";
import { achatHome } from "../config.js";
import { ConsoleMailer, ResendMailer } from "./mailer.js";
import { startCloud } from "./server.js";

// `achat serve`: the cloud service, configured from the environment (see
// deploy/achat.env.example).
export async function serve(appDir: string): Promise<void> {
  const env = process.env;
  const publicUrl = env.ACHAT_PUBLIC_URL;
  if (!publicUrl) throw new Error("需要设置 ACHAT_PUBLIC_URL，例如 https://achat.example.com");
  const mailer =
    env.RESEND_API_KEY && env.ACHAT_MAIL_FROM ? new ResendMailer(env.RESEND_API_KEY, env.ACHAT_MAIL_FROM) : new ConsoleMailer();
  if (mailer instanceof ConsoleMailer) {
    console.warn("没有设置 RESEND_API_KEY 和 ACHAT_MAIL_FROM，验证码只打印在日志里，不会发邮件。");
  }
  const cloud = await startCloud({
    dbPath: env.ACHAT_DB ?? join(achatHome(), "cloud.db"),
    webDir: join(appDir, "web"),
    appDir,
    publicUrl,
    mailer,
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? "127.0.0.1",
    trustProxy: env.ACHAT_TRUST_PROXY === "1",
  });
  console.log(`Achat 云端服务已启动：${publicUrl}（监听 ${env.HOST ?? "127.0.0.1"}:${cloud.port}）`);
  const shutdown = async (): Promise<void> => {
    await cloud.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
