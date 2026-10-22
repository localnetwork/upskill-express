import PDFDocument from "pdfkit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { env } from "../../shared/config/env.js";
import { getMyOrder } from "./order.service.js";

const LOGO_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../shared/mail/assets/new-logo.png",
);
const BRAND = "#0052CC";
const INK = "#0F172A";
const MUTED = "#64748B";
const LINE = "#E2E8F0";

// Standard PDF fonts have no peso glyph, so amounts use the currency code.
function money(value, currency = "PHP") {
  const amount = Number(value || 0);
  return `${currency} ${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function personName(person) {
  const full = `${person?.firstName || ""} ${person?.lastName || ""}`.trim();
  return full || person?.username || "";
}

export function getInvoiceFileName(orderId) {
  return `invoice-${String(orderId).slice(-10).toUpperCase()}.pdf`;
}

export async function buildOrderInvoicePdf(userId, orderId) {
  const order = await getMyOrder(userId, orderId);
  if (order.status !== "PAID") {
    throw new ApiError(409, "Invoice is only available for paid orders");
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, firstName: true, lastName: true, username: true },
  });

  const currency = order.currency || "PHP";
  const invoiceNo = String(order.id).slice(-10).toUpperCase();
  const paidDate = new Date(
    order.payment?.capturedAt || order.updatedAt || order.createdAt,
  ).toLocaleDateString("en-PH", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const left = 50;
  const right = doc.page.width - 50;
  const width = right - left;

  try {
    doc.image(LOGO_PATH, left, 45, { height: 32 });
  } catch (_error) {
    doc.font("Helvetica-Bold").fontSize(18).fillColor(BRAND).text(env.emailFromName, left, 50);
  }
  doc
    .font("Helvetica-Bold")
    .fontSize(22)
    .fillColor(INK)
    .text("INVOICE", left, 48, { width, align: "right" });
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(MUTED)
    .text(`#${invoiceNo}`, left, 76, { width, align: "right" });

  doc.moveTo(left, 100).lineTo(right, 100).lineWidth(2).strokeColor(BRAND).stroke();

  const labelValue = (label, value, x, y, w) => {
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text(label.toUpperCase(), x, y, { width: w, characterSpacing: 1 });
    doc.font("Helvetica").fontSize(11).fillColor(INK).text(value || "-", x, y + 13, { width: w });
  };

  const colW = width / 3 - 10;
  labelValue("Billed to", personName(user) || user?.email, left, 120, colW);
  doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(user?.email || "", left, 150, { width: colW });
  labelValue("Date paid", paidDate, left + colW + 15, 120, colW);
  labelValue("Payment method", order.paymentMethod || "-", left + (colW + 15) * 2, 120, colW);

  let y = 190;
  doc.rect(left, y, width, 24).fill("#F6F8FC");
  doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED);
  doc.text("COURSE", left + 10, y + 8, { characterSpacing: 1 });
  doc.text("AMOUNT", left, y + 8, { width: width - 10, align: "right", characterSpacing: 1 });
  y += 34;

  for (const item of order.items) {
    const title = item.course?.title || "Course";
    const instructor = personName(item.course?.educator);
    if (y > doc.page.height - 200) {
      doc.addPage();
      y = 50;
    }
    doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(title, left + 10, y, { width: width - 140 });
    const titleBottom = doc.y;
    if (instructor) {
      doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(`Instructor: ${instructor}`, left + 10, titleBottom + 2, { width: width - 140 });
    }
    const rowBottom = doc.y;
    doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(money(item.totalAmount, currency), left, y, { width: width - 10, align: "right" });
    y = rowBottom + 10;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(LINE).stroke();
    y += 10;
  }

  if (y > doc.page.height - 170) {
    doc.addPage();
    y = 50;
  }

  const totalsRow = (label, value, opts = {}) => {
    doc
      .font(opts.bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(opts.big ? 13 : 10)
      .fillColor(opts.bold ? INK : MUTED)
      .text(label, left + width / 2, y, { width: width / 2 - 140 });
    doc
      .font(opts.bold ? "Helvetica-Bold" : "Helvetica")
      .fillColor(opts.bold ? BRAND : INK)
      .text(value, left, y, { width: width - 10, align: "right" });
    y += opts.big ? 24 : 18;
  };

  y += 6;
  totalsRow("Subtotal", money(order.subtotalAmount, currency));
  if (Number(order.discountAmount) > 0) {
    totalsRow("Discount", `-${money(order.discountAmount, currency)}`);
  }
  if (Number(order.taxAmount) > 0) {
    totalsRow("Tax", money(order.taxAmount, currency));
  }
  y += 4;
  totalsRow("Total paid", money(order.totalAmount, currency), { bold: true, big: true });

  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(MUTED)
    .text(
      `Order ${order.id}. Thank you for learning with ${env.emailFromName}.`,
      left,
      doc.page.height - 80,
      { width, align: "center" },
    );

  doc.end();
  return done;
}
