import axios from "axios";
import { env } from "../../shared/config/env.js";

// Languages the coding exercise editor supports.
export const CODING_LANGUAGES = [
  "html",
  "javascript",
  "typescript",
  "python",
  "java",
  "php",
  "go",
  "csharp",
];
const MARKUP_LANGUAGES = new Set(["html", "css"]);

const LANGUAGE_PATTERNS = [
  ["html", /\b(html5?|css3?|markup|semantic|web ?page|stylesheets?|flexbox|bootstrap|tailwind)\b/gi],
  ["typescript", /\b(typescript|tsx?)\b/gi],
  ["javascript", /\b(javascript|js|node\.?js|react(\.?js)?|vue(\.?js)?|angular|ecmascript|es6|jquery|express(\.?js)?)\b/gi],
  ["python", /\b(python|django|flask|pandas|numpy)\b/gi],
  ["java", /\b(java|spring( boot)?|jvm)\b/gi],
  ["php", /\b(php|laravel)\b/gi],
  ["go", /\b(golang|go (lang|language|programming))\b/gi],
  ["csharp", /(c#|csharp|\.net|asp\.net)/gi],
];

const clean = (value) => String(value || "").trim();

/**
 * Picks the coding language from the lesson, section and course text instead of
 * defaulting to JavaScript. The most specific text (lesson title) weighs most.
 */
export function detectCodingLanguage({
  courseTitle,
  courseDescription,
  sectionTitle,
  lessonTitle,
  lessonDescription,
} = {}) {
  const sources = [
    [lessonTitle, 5],
    [lessonDescription, 3],
    [sectionTitle, 2],
    [courseTitle, 2],
    [courseDescription, 1],
  ];
  const scores = new Map();
  for (const [text, weight] of sources) {
    const value = clean(text);
    if (!value) continue;
    for (const [language, pattern] of LANGUAGE_PATTERNS) {
      const matches = value.match(pattern);
      if (matches) {
        scores.set(language, (scores.get(language) || 0) + matches.length * weight);
      }
    }
  }
  let best = null;
  for (const [language, score] of scores) {
    if (!best || score > best.score) best = { language, score };
  }
  return best?.language || "javascript";
}

const FALLBACK_TEMPLATES = {
  html: {
    starter: "<!DOCTYPE html>\n<html>\n  <body>\n    <!-- TODO: add a heading -->\n  </body>\n</html>",
    solution: "<!DOCTYPE html>\n<html>\n  <body>\n    <h1>Hello, world</h1>\n  </body>\n</html>",
    check: { name: "Has an <h1> with text", type: "regex", value: "<h1[^>]*>\\s*\\S+" },
  },
  javascript: {
    starter: "// TODO: print a greeting\n",
    solution: "console.log('Hello, world');",
    check: { name: "Uses console.log", type: "contains", value: "console.log(" },
  },
  typescript: {
    starter: "// TODO: declare a typed variable and print it\n",
    solution: "const message: string = 'Hello, world';\nconsole.log(message);",
    check: { name: "Declares a string variable", type: "contains", value: ": string" },
  },
  python: {
    starter: "# TODO: print a greeting\n",
    solution: "print('Hello, world')",
    check: { name: "Uses print", type: "contains", value: "print(" },
  },
  java: {
    starter: "public class Main {\n  public static void main(String[] args) {\n    // TODO: print a greeting\n  }\n}",
    solution: "public class Main {\n  public static void main(String[] args) {\n    System.out.println(\"Hello, world\");\n  }\n}",
    check: { name: "Uses System.out.println", type: "contains", value: "System.out.println(" },
  },
  php: {
    starter: "<?php\n// TODO: print a greeting\n",
    solution: "<?php\necho 'Hello, world';",
    check: { name: "Uses echo", type: "contains", value: "echo " },
  },
  go: {
    starter: "package main\n\nimport \"fmt\"\n\nfunc main() {\n\t// TODO: print a greeting\n}",
    solution: "package main\n\nimport \"fmt\"\n\nfunc main() {\n\tfmt.Println(\"Hello, world\")\n}",
    check: { name: "Uses fmt.Println", type: "contains", value: "fmt.Println(" },
  },
  csharp: {
    starter: "using System;\n\nclass Program {\n  static void Main() {\n    // TODO: print a greeting\n  }\n}",
    solution: "using System;\n\nclass Program {\n  static void Main() {\n    Console.WriteLine(\"Hello, world\");\n  }\n}",
    check: { name: "Uses Console.WriteLine", type: "contains", value: "Console.WriteLine(" },
  },
};

function normalizeMarkup(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .trim()
    .toLowerCase();
}

// Mirrors the backend source comparison so generated checks are known to pass the answer.
function checkPasses(check, code, language) {
  const isMarkup = MARKUP_LANGUAGES.has(language);
  let source = clean(code);
  let expected = clean(check.value);
  if (!expected) return false;
  if (check.type === "regex") {
    try {
      return new RegExp(expected, isMarkup ? "is" : "").test(source);
    } catch (_error) {
      return false;
    }
  }
  if (isMarkup) {
    source = normalizeMarkup(source);
    expected = normalizeMarkup(expected);
  }
  return source.includes(expected);
}

function toValidator(check, stepIndex, checkIndex) {
  const regex = check.type === "regex";
  return {
    id: `step-${stepIndex + 1}-check-${checkIndex + 1}`,
    name: clean(check.name) || `Check ${checkIndex + 1}`,
    mode: "CODE_INCLUDES",
    comparison_mode: regex ? "REGEX" : "INCLUDES",
    expected_output: clean(check.value),
    input: "",
    visibility: "VISIBLE",
  };
}

function buildStep({ index, title, instruction, starterCode, solution, checks, hints, language }) {
  const validators = (Array.isArray(checks) ? checks : [])
    .filter((check) => checkPasses(check, solution, language))
    .map((check, checkIndex) => toValidator(check, index, checkIndex));
  if (!validators.length) return null;

  return {
    id: `step-${Date.now()}-${index + 1}`,
    step_number: index + 1,
    title: clean(title) || `Step ${index + 1}`,
    instruction: clean(instruction),
    starter_code: String(starterCode || ""),
    hints: (Array.isArray(hints) ? hints : []).map(clean).filter(Boolean),
    validators,
    validation_mode: validators[0].mode,
    comparison_mode: validators[0].comparison_mode,
    expected_output: validators[0].expected_output,
  };
}

function buildFallbackAsset({ language, lessonTitle, sectionTitle, courseTitle }) {
  const template = FALLBACK_TEMPLATES[language] || FALLBACK_TEMPLATES.javascript;
  const topic = clean(lessonTitle) || clean(sectionTitle) || clean(courseTitle) || "this lesson";
  const step = buildStep({
    index: 0,
    title: "Write your first solution",
    instruction: `Complete the starter code for "${topic}".`,
    starterCode: template.starter,
    solution: template.solution,
    checks: [template.check],
    hints: ["Start from the starter code and complete the TODO.", `Answer:\n${template.solution}`],
    language,
  });
  return {
    languages: [language],
    hints: [],
    step_challenges: { [language]: step ? [step] : [] },
    metadata: { status: "Draft" },
  };
}

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

async function requestAIExercise({ language, courseTitle, sectionTitle, lessonTitle, lessonDescription }) {
  const isMarkup = MARKUP_LANGUAGES.has(language);
  const systemPrompt =
    "You design hands-on coding exercises for an online course. Return only valid JSON with no markdown fences. " +
    `The exercise language is fixed to "${language}"; every starter_code and solution must be valid ${language}. ` +
    'Schema: { "instructions": string, "steps": [{ "title": string, "instruction": string, "starter_code": string, "solution": string, "hint": string, "checks": [{ "name": string, "type": "contains"|"regex", "value": string }] }] }. ' +
    "Create 2-4 progressive steps. starter_code is the code the learner begins that step with (later steps build on the previous solution). " +
    "solution is the full correct code for that step. Each check validates the learner's SOURCE CODE, and every check must pass against that step's solution. " +
    (isMarkup
      ? "Use regex checks for flexible tag matching (e.g. <h1[^>]*>\\s*\\S+) and keep values lowercase. "
      : "Use short contains checks for key constructs, or regex when flexible. ") +
    "Give each step 1-3 checks. hint is one short nudge that does not reveal the full solution.";

  const response = await axios.post(
    `${env.deepseekBaseUrl.replace(/\/+$/g, "")}/chat/completions`,
    {
      model: env.deepseekModel,
      temperature: 0.4,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content:
            `Course: ${clean(courseTitle)}\nSection: ${clean(sectionTitle)}\nLesson: ${clean(lessonTitle)}\n` +
            `Lesson description: ${clean(lessonDescription).slice(0, 1500)}\nLanguage: ${language}`,
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

/**
 * Builds the stored coding exercise asset (language, steps, starter code,
 * checks and hints with answers) for an AI-drafted lesson.
 */
export async function buildAICodingExercise(context) {
  const language = detectCodingLanguage(context);
  const fallback = () => ({
    language,
    instructions: "",
    asset: buildFallbackAsset({ language, ...context }),
  });

  if (!env.aiKey) return fallback();

  try {
    const parsed = await requestAIExercise({ language, ...context });
    const rawSteps = Array.isArray(parsed?.steps) ? parsed.steps.slice(0, 4) : [];
    const steps = [];

    rawSteps.forEach((raw) => {
      const solution = String(raw?.solution || "");
      const step = buildStep({
        index: steps.length,
        title: raw?.title,
        instruction: raw?.instruction,
        starterCode: raw?.starter_code,
        solution,
        checks: raw?.checks,
        hints: [clean(raw?.hint), `Answer:\n${solution}`],
        language,
      });
      if (!step || !step.instruction || !clean(solution)) return;
      steps.push(step);
    });

    if (!steps.length) return fallback();

    return {
      language,
      instructions: clean(parsed?.instructions),
      asset: {
        languages: [language],
        hints: [],
        step_challenges: { [language]: steps },
        metadata: { status: "Draft" },
      },
    };
  } catch (_error) {
    return fallback();
  }
}
