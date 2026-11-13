import axios from "axios";
import { env } from "../../shared/config/env.js";
import { ApiError } from "../../shared/utils/ApiError.js";

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

export async function askInterviewAi(systemPrompt, payload, { temperature = 0.6 } = {}) {
  if (!env.aiKey) {
    throw new ApiError(
      500,
      "AI key is not configured. Set AI_KEY in the backend environment.",
    );
  }

  let response;
  try {
    response = await axios.post(
      `${env.deepseekBaseUrl.replace(/\/+$/g, "")}/chat/completions`,
      {
        model: env.deepseekModel,
        temperature,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(payload) },
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

  const parsed = readJson(response?.data?.choices?.[0]?.message?.content);
  if (!parsed) {
    throw new ApiError(502, "AI returned an invalid response. Please try again.");
  }
  return parsed;
}

const PERSONA =
  "You are Alex, a friendly but rigorous senior interviewer running a spoken mock interview. " +
  "Your replies are read aloud, so use plain conversational sentences: no markdown, lists, or code blocks. " +
  "Ask exactly ONE question at a time and base it on the course material provided. " +
  "Return ONLY valid JSON with no markdown fences.";

export const OPENING_PROMPT =
  `${PERSONA} Schema: {"question": string}. ` +
  "Greet the candidate in one short sentence, then ask the first question (max 60 words total).";

export const TURN_PROMPT =
  `${PERSONA} Schema: {"feedback": string, "score": integer 0-10, "nextQuestion": string}. ` +
  "feedback is 1-2 sentences of constructive evaluation of the candidate's latest answer. " +
  "nextQuestion is the next single question: a follow-up if the answer was weak or shallow, otherwise a new topic from the course. " +
  "Never repeat an earlier question. Keep nextQuestion under 50 words. " +
  "If the candidate says they do not know, stay encouraging.";

export const FINAL_PROMPT =
  `${PERSONA} Schema: {"score": integer 0-100, "summary": string, "strengths": string[], "improvements": string[], "recommendedTopics": string[]}. ` +
  "Evaluate the whole interview fairly. summary is 2-3 sentences. Provide 2-4 items for each array.";
