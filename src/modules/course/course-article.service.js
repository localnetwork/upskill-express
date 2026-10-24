import axios from "axios";
import { env } from "../../shared/config/env.js";

const MAX_ARTICLE_CHARS = 60000;
const ALLOWED_TAGS = new Set([
  "h2", "h3", "h4", "p", "ul", "ol", "li", "strong", "em", "b", "i", "u",
  "code", "pre", "blockquote", "br", "hr", "a", "table", "thead", "tbody",
  "tr", "th", "td",
]);

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stripFences(content) {
  return String(content || "")
    .trim()
    .replace(/^```(?:html)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

// Allowlist sanitizer: article HTML is rendered with dangerouslySetInnerHTML.
export function sanitizeArticleHtml(html) {
  const withoutDangerousBlocks = String(html || "").replace(
    /<(script|style|iframe|object|embed|form|svg|math)[\s\S]*?<\/\1\s*>/gi,
    "",
  );

  return withoutDangerousBlocks.replace(
    /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g,
    (match, rawTag, rawAttrs) => {
      const tag = rawTag.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) return "";
      if (match.startsWith("</")) return `</${tag}>`;
      if (tag === "a") {
        const href = /href\s*=\s*"(https?:\/\/[^"\s]*)"/i.exec(rawAttrs)?.[1];
        return href
          ? `<a href="${href}" target="_blank" rel="noopener noreferrer">`
          : "<a>";
      }
      return `<${tag}>`;
    },
  );
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function requestArticle({
  courseTitle,
  courseDescription,
  sectionTitle,
  lessonTitle,
  lessonDescription,
  language,
}) {
  const systemPrompt =
    "You are an expert instructional designer and subject-matter writer producing a full lecture article for an online course. " +
    "Return ONLY the article body as clean HTML, with no markdown fences, no <html>/<body> wrapper and no <h1> (the lesson title is shown separately). " +
    "Allowed tags: h2, h3, p, ul, ol, li, strong, em, code, pre, blockquote, table, thead, tbody, tr, th, td, a. " +
    "Write 900-1500 words, accurate, specific and concrete; never use filler or placeholders. " +
    "Structure: (1) a short introduction and why it matters, (2) a <h2>Learning objectives</h2> list of 3-5 measurable outcomes, " +
    "(3) several <h2> sections that explain the core concepts in depth, each with definitions, reasoning and at least one realistic worked example " +
    "(use <pre><code> for code, commands or formulas where relevant), (4) a <h2>Step-by-step walkthrough</h2> ordered list applying the idea to a real scenario, " +
    "(5) <h2>Common mistakes and how to avoid them</h2>, (6) <h2>Key takeaways</h2> bullet summary, " +
    "(7) <h2>Practice and reflection</h2> with 3-4 questions or small exercises. " +
    "Match the course level and context, and build on the section topic without repeating other lessons.";

  const response = await axios.post(
    `${env.deepseekBaseUrl.replace(/\/+$/g, "")}/chat/completions`,
    {
      model: env.deepseekModel,
      temperature: 0.6,
      max_tokens: 4000,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content:
            `Course: ${clean(courseTitle)}\n` +
            `Course description: ${clean(courseDescription).slice(0, 800)}\n` +
            `Section: ${clean(sectionTitle)}\n` +
            `Lecture title: ${clean(lessonTitle)}\n` +
            `Lecture outline/notes: ${clean(lessonDescription).slice(0, 1500)}\n` +
            `Language: ${language || "English"}`,
        },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${env.aiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 120000,
    },
  );
  return response?.data?.choices?.[0]?.message?.content || "";
}

function buildFallbackArticle({ lessonTitle, lessonDescription }) {
  const text = clean(lessonDescription);
  if (!text) return null;
  return `<h2>${escapeHtml(clean(lessonTitle) || "Overview")}</h2><p>${escapeHtml(text)}</p>`;
}

/**
 * Generates a detailed HTML lecture article for an AI-drafted lesson.
 * Returns null when AI is unavailable so callers keep their existing fallback.
 */
export async function buildAIArticleContent(context) {
  if (!env.aiKey) return null;

  try {
    const raw = await requestArticle(context);
    const html = sanitizeArticleHtml(stripFences(raw)).slice(0, MAX_ARTICLE_CHARS).trim();
    const plainLength = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length;
    // Reject truncated or empty responses so a short stub never replaces the fallback.
    return plainLength >= 800 ? html : null;
  } catch (_error) {
    return null;
  }
}

export { buildFallbackArticle };
