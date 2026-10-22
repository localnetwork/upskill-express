import nodemailer from "nodemailer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";

const LOGO_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "assets/new-logo.png",
);

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!env.emailUser || !env.emailPassword) return null;

  const auth = { user: env.emailUser, pass: env.emailPassword };
  transporter = env.emailHost
    ? nodemailer.createTransport({
        host: env.emailHost,
        port: env.emailPort,
        secure: env.emailPort === 465,
        auth,
      })
    : nodemailer.createTransport({
        service: env.emailService || "gmail",
        auth,
      });
  return transporter;
}

/**
 * Sends an email. Never throws: mail failures must not break the calling
 * flow (registration, checkout, ...). Returns true when the mail was sent.
 */
export async function sendEmail({ to, subject, html, text }) {
  const client = getTransporter();
  if (!client) {
    console.warn("[mail] EMAIL_USER / EMAIL_PASSWORD not configured; skipped", {
      subject,
    });
    return false;
  }
  if (!to) return false;

  try {
    await client.sendMail({
      from: `"${env.emailFromName}" <${env.emailUser}>`,
      to,
      subject,
      html,
      text,
      attachments: [
        {
          filename: "new-logo.png",
          path: LOGO_PATH,
          cid: "upskill-logo",
        },
      ],
    });
    return true;
  } catch (error) {
    console.error("[mail] Failed to send email", {
      subject,
      to,
      message: error?.message,
    });
    return false;
  }
}
