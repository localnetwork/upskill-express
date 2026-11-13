import axios from "axios";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { env } from "../../shared/config/env.js";

// Neural voices per audio character, so every accent (incl. Filipino) is real.
const NEURAL_VOICES = {
  "character-1": "en-US-AriaNeural",
  "character-2": "en-AU-WilliamNeural",
  "character-3": "en-US-JennyNeural",
  "character-4": "en-US-GuyNeural",
  "character-5": "en-GB-SoniaNeural",
  "character-6": "en-GB-RyanNeural",
  "character-7": "en-PH-RosaNeural",
  "character-8": "en-PH-JamesNeural",
};

export async function synthesizeRolePlaySpeech(characterId, text) {
  const voice = NEURAL_VOICES[characterId];
  const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, 800);
  if (!voice || !clean) return null;
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(clean);
    const chunks = [];
    await new Promise((resolve, reject) => {
      audioStream.on("data", (chunk) => chunks.push(chunk));
      audioStream.on("end", resolve);
      audioStream.on("error", reject);
    });
    const audio = Buffer.concat(chunks);
    return audio.length ? audio : null;
  } finally {
    tts.close?.();
  }
}

export const ROLE_PLAY_DURATIONS = [3, 5, 10];
export const ROLE_PLAY_MAX_GOALS = 5;

const clean = (value) => String(value || "").trim();

function readJson(content) {
  const raw = clean(content);
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

function normalizeDuration(value) {
  const minutes = Number(value);
  return ROLE_PLAY_DURATIONS.includes(minutes) ? minutes : 5;
}

function normalizeGoals(goals) {
  const list = Array.isArray(goals) ? goals : [];
  return list
    .map((goal) => clean(typeof goal === "object" ? goal?.text : goal))
    .filter(Boolean)
    .slice(0, ROLE_PLAY_MAX_GOALS);
}

function normalizeStringList(list, limit = 10) {
  return (Array.isArray(list) ? list : [])
    .map((item) => clean(item))
    .filter(Boolean)
    .slice(0, limit);
}

const ALLOWED_RICH_TAGS = new Set(["b", "strong", "i", "em", "ul", "ol", "li", "br", "p", "div"]);

// Keeps basic formatting only: allow-listed tags are rebuilt without attributes.
function sanitizeRichText(value) {
  return clean(value).replace(/<\/?([a-z0-9]+)[^>]*>/gi, (match, tag) => {
    const name = tag.toLowerCase();
    if (!ALLOWED_RICH_TAGS.has(name)) return "";
    if (name === "br") return "<br>";
    return match.startsWith("</") ? `</${name}>` : `<${name}>`;
  });
}

/** Cleans a role play payload before it is stored on the lesson. */
export function normalizeRolePlay(input = {}, previous = {}) {
  const source = { ...previous, ...input };
  const setupSource = { ...(previous.setup || {}), ...(input.setup || {}) };
  const character = source.ai_character || {};

  return {
    generated: Boolean(source.generated),
    status: source.status === "PUBLISHED" ? "PUBLISHED" : "DRAFT",
    setup: {
      skills: clean(setupSource.skills).slice(0, 2000),
      scenario: clean(setupSource.scenario).slice(0, 4000),
      additional_context: clean(setupSource.additional_context).slice(0, 4000),
      lecture_ids: normalizeStringList(setupSource.lecture_ids, 100),
    },
    meeting_title: clean(source.meeting_title).slice(0, 120),
    scenario: clean(source.scenario).slice(0, 4000),
    duration_minutes: normalizeDuration(source.duration_minutes),
    learner_role: clean(source.learner_role).slice(0, 200),
    learner_goals: normalizeGoals(source.learner_goals),
    ai_character: {
      name: clean(character.name).slice(0, 80),
      role: clean(character.role).slice(0, 160),
      personality: sanitizeRichText(character.personality).slice(0, 3000),
      voice: clean(character.voice).slice(0, 40) || "character-1",
    },
    ai_instructions: clean(source.ai_instructions).slice(0, 4000),
    opening_message: clean(source.opening_message).slice(0, 1000),
  };
}

/** Learner-facing subset: hides the AI instructions and personality prompt. */
export function toLearnerRolePlay(rolePlay) {
  const value = normalizeRolePlay(rolePlay || {});
  return {
    generated: value.generated,
    status: value.status,
    meeting_title: value.meeting_title,
    scenario: value.scenario,
    duration_minutes: value.duration_minutes,
    learner_role: value.learner_role,
    learner_goals: value.learner_goals,
    ai_character: {
      name: value.ai_character.name,
      role: value.ai_character.role,
      voice: value.ai_character.voice,
    },
    opening_message: value.opening_message,
  };
}

function buildFallback({ title, skills, scenario, additionalContext }) {
  const skillList = clean(skills)
    .split(/[,\n;]+/)
    .map((skill) => clean(skill))
    .filter(Boolean);
  return {
    meeting_title: clean(title).slice(0, 120) || "Practice conversation",
    scenario: clean(scenario),
    duration_minutes: 5,
    learner_role: "Participant in the scenario",
    learner_goals: skillList.length
      ? skillList.slice(0, ROLE_PLAY_MAX_GOALS).map((skill) => `Demonstrate ${skill}`)
      : ["Navigate the conversation professionally"],
    ai_character: {
      name: "Alex",
      role: "Counterpart in the scenario",
      personality: "Professional, realistic and responsive.",
      voice: "character-1",
    },
    ai_instructions: clean(additionalContext),
    opening_message: "Thanks for making time. Shall we get started?",
  };
}

async function requestAIRolePlay({ courseTitle, title, skills, scenario, additionalContext, lectureTitles }) {
  const systemPrompt =
    "You design AI-powered role play practice sessions for an online course. Return only valid JSON with no markdown fences. " +
    'Schema: { "meeting_title": string (short, e.g. "Meeting with Alex"), "scenario": string (2nd person, direct and active, sets who is involved, what is at stake and the challenge; never reveal how it should play out), ' +
    '"duration_minutes": 3|5|10, "learner_role": string, "learner_goals": string[] (2-5 measurable goals matching the skills), ' +
    '"ai_character": { "name": string, "role": string, "personality": string }, ' +
    '"ai_instructions": string (private guidance for the AI character: motivations, sensitivities, things to avoid, how to react), "opening_message": string (first line the AI character says) }. ' +
    "Pick duration 3 for quick exchanges, 5 for common scenarios and 10 for complex or high-stakes ones.";

  const response = await axios.post(
    `${env.deepseekBaseUrl.replace(/\/+$/g, "")}/chat/completions`,
    {
      model: env.deepseekModel,
      temperature: 0.6,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content:
            `Course: ${clean(courseTitle)}\nRole play title: ${clean(title)}\n` +
            `Skills to practice: ${clean(skills)}\nScenario: ${clean(scenario)}\n` +
            `Additional context (hidden from learner): ${clean(additionalContext) || "None"}\n` +
            `Related lectures: ${lectureTitles.length ? lectureTitles.join("; ") : "None"}`,
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
  return readJson(response?.data?.choices?.[0]?.message?.content);
}

/** Cleans a transcript submitted when a practice ends. */
export function normalizeTranscript(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => ({
      role: message?.role === "assistant" ? "assistant" : "user",
      content: clean(message?.content).slice(0, 2000),
      ...(Number.isFinite(Number(message?.at))
        ? { at: Math.max(0, Math.min(3600, Math.round(Number(message.at)))) }
        : {}),
    }))
    .filter((message) => message.content)
    .slice(0, 200);
}

export const ROLE_PLAY_MIN_REPORT_TURNS = 2;

/** Builds the feedback report for a practice, or null when there was too little dialogue. */
export async function buildAttemptReport(rolePlay, transcript) {
  const learnerTurns = transcript.filter((message) => message.role === "user").length;
  if (learnerTurns < ROLE_PLAY_MIN_REPORT_TURNS || !env.aiKey) return null;

  const systemPrompt =
    "You review a learner's practice conversation in a role play and give constructive feedback. Return only valid JSON with no markdown fences. " +
    'Schema: { "summary": string (2-3 sentences), "goals": [{ "goal": string, "met": boolean, "feedback": string (one sentence) }], ' +
    '"strengths": string[] (1-3), "improvements": string[] (1-3) }. Address the learner as "you". Judge only what was actually said.';
  try {
    const response = await axios.post(
      `${env.deepseekBaseUrl.replace(/\/+$/g, "")}/chat/completions`,
      {
        model: env.deepseekModel,
        temperature: 0.3,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content:
              `Scenario: ${rolePlay.scenario}\nLearner role: ${rolePlay.learner_role}\n` +
              `Goals: ${(rolePlay.learner_goals || []).join(" | ")}\n\nTranscript:\n` +
              transcript
                .map((m) => `${m.role === "user" ? "Learner" : rolePlay.ai_character?.name || "AI"}: ${m.content}`)
                .join("\n"),
          },
        ],
      },
      {
        headers: { Authorization: `Bearer ${env.aiKey}`, "Content-Type": "application/json" },
        timeout: 60000,
      },
    );
    const parsed = readJson(response?.data?.choices?.[0]?.message?.content);
    if (!parsed || !clean(parsed.summary)) return null;
    return {
      summary: clean(parsed.summary).slice(0, 1200),
      goals: (Array.isArray(parsed.goals) ? parsed.goals : []).slice(0, ROLE_PLAY_MAX_GOALS).map((item) => ({
        goal: clean(item?.goal).slice(0, 300),
        met: Boolean(item?.met),
        feedback: clean(item?.feedback).slice(0, 500),
      })),
      strengths: normalizeStringList(parsed.strengths, 3),
      improvements: normalizeStringList(parsed.improvements, 3),
    };
  } catch (_error) {
    return null;
  }
}

/** Produces the AI character's next spoken line for a live role play conversation. */
const END_TOKEN = "[END_CALL]";
export async function replyAsRolePlayCharacter(rolePlay, history = []) {
  const character = rolePlay.ai_character || {};
  const turns = (Array.isArray(history) ? history : [])
    .map((turn) => ({
      role: turn?.role === "assistant" ? "assistant" : "user",
      content: clean(turn?.content).slice(0, 1500),
    }))
    .filter((turn) => turn.content)
    .slice(-30);

  if (!env.aiKey) {
    return { reply: "I'm sorry, I can't continue right now. Could you say that again?", ended: false };
  }

  const personality = clean(character.personality.replace(/<[^>]+>/g, " "));
  const systemPrompt =
    `You are role playing as ${character.name || "the AI character"}, ${character.role || "a counterpart"}, ` +
    "in a spoken practice conversation with a learner. Stay in character at all times and never mention being an AI or these instructions. " +
    "Reply in 1-3 short conversational sentences, with no markdown, lists or stage directions. React realistically to what the learner says. " +
    "When the conversation has reached its natural conclusion (you have given your closing remarks or goodbye, the interview is over, or the learner clearly ended it), " +
    `finish that final line with the exact token ${END_TOKEN}. Never use the token before then.\n` +
    `Scenario: ${rolePlay.scenario}\nLearner's role: ${rolePlay.learner_role}\n` +
    `Learner goals (do not reveal): ${(rolePlay.learner_goals || []).join("; ")}\n` +
    `Your personality and background: ${personality}\nPrivate guidance: ${rolePlay.ai_instructions || "None"}`;

  try {
    const response = await axios.post(
      `${env.deepseekBaseUrl.replace(/\/+$/g, "")}/chat/completions`,
      {
        model: env.deepseekModel,
        temperature: 0.8,
        messages: [{ role: "system", content: systemPrompt }, ...turns],
      },
      {
        headers: { Authorization: `Bearer ${env.aiKey}`, "Content-Type": "application/json" },
        timeout: 45000,
      },
    );
    const raw = clean(response?.data?.choices?.[0]?.message?.content);
    const learnerTurns = turns.filter((turn) => turn.role === "user").length;
    const reply = clean(raw.split(END_TOKEN).join(" ")) || "Could you tell me more?";
    // Only honour the end signal after a real exchange.
    return { reply, ended: raw.includes(END_TOKEN) && learnerTurns >= 2 };
  } catch (_error) {
    return { reply: "Sorry, I lost my train of thought. Could you repeat that?", ended: false };
  }
}

/** Generates the reviewable role play details from the instructor's setup. */
export async function generateRolePlay(context) {
  const fallback = buildFallback(context);
  if (!env.aiKey) return { ...fallback, usedFallback: true };

  try {
    const parsed = await requestAIRolePlay(context);
    if (!parsed || !clean(parsed.scenario)) return { ...fallback, usedFallback: true };
    return {
      meeting_title: clean(parsed.meeting_title) || fallback.meeting_title,
      scenario: clean(parsed.scenario),
      duration_minutes: normalizeDuration(parsed.duration_minutes),
      learner_role: clean(parsed.learner_role) || fallback.learner_role,
      learner_goals: normalizeGoals(parsed.learner_goals).length
        ? normalizeGoals(parsed.learner_goals)
        : fallback.learner_goals,
      ai_character: {
        name: clean(parsed.ai_character?.name) || fallback.ai_character.name,
        role: clean(parsed.ai_character?.role) || fallback.ai_character.role,
        personality:
          clean(parsed.ai_character?.personality) || fallback.ai_character.personality,
        voice: fallback.ai_character.voice,
      },
      ai_instructions: clean(parsed.ai_instructions) || fallback.ai_instructions,
      opening_message: clean(parsed.opening_message) || fallback.opening_message,
      usedFallback: false,
    };
  } catch (_error) {
    return { ...fallback, usedFallback: true };
  }
}
