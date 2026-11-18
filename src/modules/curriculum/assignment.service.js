const MAX_TEXT = 20000;

function str(value, max = MAX_TEXT) {
  return String(value ?? "").slice(0, max);
}

const ALLOWED_TAGS = new Set(["b", "i", "strong", "em", "br", "p", "div", "ul", "ol", "li", "u"]);

// Rich text is limited to basic formatting tags with all attributes dropped.
function html(value) {
  return str(value)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (match, tag) => {
      const name = tag.toLowerCase();
      if (!ALLOWED_TAGS.has(name)) return "";
      return match.startsWith("</") ? `</${name}>` : `<${name}>`;
    })
    .replace(/<(?!\/?[a-z])/gi, "&lt;");
}

function normalizeFile(input) {
  if (!input || typeof input !== "object" || !input.path) return null;
  return {
    path: str(input.path, 2000),
    name: str(input.name, 300),
    size: Number(input.size) || 0,
    type: str(input.type, 100),
    uploaded_at: input.uploaded_at || new Date().toISOString(),
  };
}

export function normalizeAssignment(input = {}, previous = {}) {
  const src = { ...previous, ...(input && typeof input === "object" ? input : {}) };
  const instructions = src.instructions || {};
  const solutions = src.solutions || {};

  const questions = (Array.isArray(src.questions) ? src.questions : [])
    .slice(0, 50)
    .map((q, index) => ({
      id: str(q?.id, 64) || `q${Date.now()}${index}`,
      body: html(q?.body),
    }))
    .filter((q) => q.body.trim());
  const ids = new Set(questions.map((q) => q.id));

  const answers = {};
  Object.entries(solutions.answers || {}).forEach(([id, body]) => {
    if (ids.has(id) && String(body || "").trim()) answers[id] = html(body);
  });

  return {
    status: src.status === "PUBLISHED" ? "PUBLISHED" : "DRAFT",
    instructions: {
      video: normalizeFile(instructions.video),
      text: html(instructions.text),
      resource: normalizeFile(instructions.resource),
    },
    questions,
    solutions: {
      video: normalizeFile(solutions.video),
      answers,
      resource: normalizeFile(solutions.resource),
    },
  };
}

// Learners see instructions, questions and the instructor example (solutions).
export function toLearnerAssignment(assignment) {
  const a = normalizeAssignment(assignment || {});
  return {
    status: a.status,
    instructions: a.instructions,
    questions: a.questions,
    solutions: a.solutions,
  };
}

export function normalizeSubmissionAnswers(input, questions = []) {
  const ids = new Set(questions.map((q) => q.id));
  const answers = {};
  Object.entries(input && typeof input === "object" ? input : {}).forEach(
    ([id, body]) => {
      if (ids.has(id)) answers[id] = html(body);
    },
  );
  return answers;
}
