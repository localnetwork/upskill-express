import axios from "axios";
import { env } from "../../shared/config/env.js";
import { ApiError } from "../../shared/utils/ApiError.js";

const ALLOWED_ICONS = [
  "Code2",
  "BriefcaseBusiness",
  "Wallet",
  "SwatchBook",
  "Megaphone",
  "Dumbbell",
  "Camera",
  "Music",
  "GraduationCap",
  "FolderOpen",
];

function readJson(content) {
  const raw = String(content || "").trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  try {
    return JSON.parse(candidate);
  } catch (_error) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch (_nested) {
      return null;
    }
  }
}

function sanitizeDescriptionHtml(value) {
  return String(value || "")
    .replace(/<\s*(script|style|iframe)[\s\S]*?<\/\s*\1\s*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, "")
    .trim();
}

export async function suggestCategoryContent(payload = {}) {
  if (!env.aiKey) {
    throw new ApiError(
      500,
      "AI key is not configured. Set AI_KEY in the backend environment.",
    );
  }

  const title = String(payload.title || "").trim().slice(0, 150);
  if (title.length < 2) {
    throw new ApiError(400, "Enter a category title first");
  }

  const parentTitle = String(payload.parentTitle || "").trim().slice(0, 150);
  const existingDescription = String(payload.existingDescription || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1500);
  const instruction = String(payload.instruction || "").trim().slice(0, 500);
  const descriptionOnly = payload.fields === "description";

  const systemPrompt =
    "You write copy for an online course marketplace's category pages. " +
    "Return ONLY valid JSON with no markdown fences. " +
    'Schema: {"description": string, "icon": string, "color": string}. ' +
    "description is 2 short HTML paragraphs (<p> tags only, optionally <strong>), 40-90 words total, " +
    "explaining what learners will find in this category; no headings, no links. " +
    `icon must be exactly one of: ${ALLOWED_ICONS.join(", ")}. ` +
    "color is a hex color like #0056D2 that suits the topic and is dark enough for white text.";

  let aiResponse;
  try {
    aiResponse = await axios.post(
      `${env.deepseekBaseUrl.replace(/\/+$/g, "")}/chat/completions`,
      {
        model: env.deepseekModel,
        temperature: 0.6,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: JSON.stringify({
              category_title: title,
              parent_category: parentTitle || null,
              existing_description: existingDescription || null,
              extra_instruction: instruction || null,
              task: existingDescription
                ? "Improve and rewrite the existing description, keeping its intent."
                : "Write a new description.",
            }),
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${env.aiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 60000,
      },
    );
  } catch (_error) {
    throw new ApiError(502, "AI provider is unavailable right now. Please try again.");
  }

  const parsed = readJson(aiResponse?.data?.choices?.[0]?.message?.content);
  const description = sanitizeDescriptionHtml(parsed?.description);
  if (!description) {
    throw new ApiError(502, "AI returned an empty response. Please try again.");
  }

  const result = { description };
  if (!descriptionOnly) {
    if (ALLOWED_ICONS.includes(parsed?.icon)) result.icon = parsed.icon;
    if (/^#[0-9a-f]{6}$/i.test(String(parsed?.color || ""))) {
      result.color = parsed.color;
    }
  }
  return result;
}
