import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { activeEnrollmentFilter } from "../access/access.service.js";
import {
  askInterviewAi,
  FINAL_PROMPT,
  OPENING_PROMPT,
  TURN_PROMPT,
} from "./mock-interview.ai.js";

const clampScore = (value, max) =>
  Math.max(0, Math.min(max, Math.round(Number(value) || 0)));

const text = (value, max = 1000) => String(value || "").trim().slice(0, max);

const list = (value) =>
  Array.isArray(value) ? value.map((item) => text(item, 300)).filter(Boolean).slice(0, 6) : [];

async function assertCourseAccess(userId, courseId) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, deletedAt: null },
    select: {
      id: true,
      title: true,
      subtitle: true,
      description: true,
      educatorId: true,
      sections: {
        orderBy: { position: "asc" },
        select: {
          title: true,
          lessons: { orderBy: { position: "asc" }, select: { title: true } },
        },
      },
    },
  });
  if (!course) throw new ApiError(404, "Course not found");

  if (course.educatorId !== userId) {
    const enrollment = await prisma.enrollment.findFirst({
      where: { userId, courseId, ...activeEnrollmentFilter() },
      select: { id: true },
    });
    if (!enrollment) throw new ApiError(403, "Enroll in this course to start a mock interview");
  }
  return course;
}

function buildCourseContext(course) {
  return {
    title: course.title,
    subtitle: course.subtitle || null,
    description: String(course.description || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1200),
    curriculum: course.sections.slice(0, 20).map((section) => ({
      section: section.title,
      lessons: section.lessons.slice(0, 15).map((lesson) => lesson.title),
    })),
  };
}

async function loadOwnedInterview(userId, interviewId) {
  const interview = await prisma.mockInterview.findFirst({
    where: { id: interviewId, userId },
    include: { turns: { orderBy: { position: "asc" } } },
  });
  if (!interview) throw new ApiError(404, "Mock interview not found");
  return interview;
}

const toTranscript = (turns) =>
  turns.map((turn) => ({
    speaker: turn.speaker === "AI" ? "interviewer" : "candidate",
    text: turn.text,
  }));

function serialize(interview) {
  return {
    id: interview.id,
    courseId: interview.courseId,
    role: interview.role,
    difficulty: interview.difficulty,
    status: interview.status,
    maxQuestions: interview.maxQuestions,
    score: interview.score,
    summary: interview.summary,
    report: interview.report,
    startedAt: interview.startedAt,
    finishedAt: interview.finishedAt,
    turns: (interview.turns || []).map((turn) => ({
      id: turn.id,
      position: turn.position,
      speaker: turn.speaker,
      text: turn.text,
      feedback: turn.feedback,
      score: turn.score,
    })),
  };
}

export async function startMockInterview(userId, payload) {
  const course = await assertCourseAccess(userId, payload.courseId);
  const difficulty = payload.difficulty || "intermediate";
  const role = text(payload.role, 100) || null;
  const maxQuestions = payload.maxQuestions || 6;

  const opening = await askInterviewAi(OPENING_PROMPT, {
    course: buildCourseContext(course),
    candidate_target_role: role,
    difficulty,
  });
  const question = text(opening.question, 600);
  if (!question) throw new ApiError(502, "AI returned an empty question. Please try again.");

  const interview = await prisma.mockInterview.create({
    data: {
      userId,
      courseId: course.id,
      role,
      difficulty,
      maxQuestions,
      turns: { create: { position: 1, speaker: "AI", text: question } },
    },
    include: { turns: { orderBy: { position: "asc" } } },
  });
  return serialize(interview);
}

export async function answerMockInterview(userId, interviewId, { answer }) {
  const interview = await loadOwnedInterview(userId, interviewId);
  if (interview.status !== "IN_PROGRESS") {
    throw new ApiError(400, "This interview has already finished");
  }
  const last = interview.turns[interview.turns.length - 1];
  if (!last || last.speaker !== "AI") {
    throw new ApiError(409, "Waiting for the interviewer's question");
  }

  const course = await assertCourseAccess(userId, interview.courseId);
  const questionsAsked = interview.turns.filter((turn) => turn.speaker === "AI").length;
  const isLast = questionsAsked >= interview.maxQuestions;

  const ai = await askInterviewAi(
    TURN_PROMPT,
    {
      course: buildCourseContext(course),
      candidate_target_role: interview.role,
      difficulty: interview.difficulty,
      transcript: toTranscript(interview.turns),
      latest_answer: answer,
      is_final_question: isLast,
      note: isLast
        ? "This was the final question; nextQuestion may be an empty string."
        : undefined,
    },
    { temperature: 0.5 },
  );

  const feedback = text(ai.feedback, 600) || null;
  const nextQuestion = isLast ? "" : text(ai.nextQuestion, 600);
  if (!isLast && !nextQuestion) {
    throw new ApiError(502, "AI returned an empty question. Please try again.");
  }

  const base = last.position;
  await prisma.$transaction([
    prisma.mockInterviewTurn.create({
      data: {
        interviewId,
        position: base + 1,
        speaker: "USER",
        text: answer,
        feedback,
        score: clampScore(ai.score, 10),
      },
    }),
    ...(nextQuestion
      ? [
          prisma.mockInterviewTurn.create({
            data: { interviewId, position: base + 2, speaker: "AI", text: nextQuestion },
          }),
        ]
      : []),
  ]);

  return { feedback, score: clampScore(ai.score, 10), nextQuestion: nextQuestion || null, done: isLast };
}

export async function finishMockInterview(userId, interviewId) {
  const interview = await loadOwnedInterview(userId, interviewId);
  if (interview.status === "COMPLETED") return serialize(interview);

  const answered = interview.turns.filter((turn) => turn.speaker === "USER");
  if (answered.length === 0) {
    const abandoned = await prisma.mockInterview.update({
      where: { id: interviewId },
      data: { status: "ABANDONED", finishedAt: new Date() },
      include: { turns: { orderBy: { position: "asc" } } },
    });
    return serialize(abandoned);
  }

  const course = await assertCourseAccess(userId, interview.courseId);
  const ai = await askInterviewAi(
    FINAL_PROMPT,
    {
      course: buildCourseContext(course),
      candidate_target_role: interview.role,
      difficulty: interview.difficulty,
      transcript: toTranscript(interview.turns),
      per_answer_scores: answered.map((turn) => turn.score),
    },
    { temperature: 0.3 },
  );

  const report = {
    strengths: list(ai.strengths),
    improvements: list(ai.improvements),
    recommendedTopics: list(ai.recommendedTopics),
  };
  const updated = await prisma.mockInterview.update({
    where: { id: interviewId },
    data: {
      status: "COMPLETED",
      score: clampScore(ai.score, 100),
      summary: text(ai.summary, 1200) || null,
      report,
      finishedAt: new Date(),
    },
    include: { turns: { orderBy: { position: "asc" } } },
  });
  return serialize(updated);
}

export async function getMockInterview(userId, interviewId) {
  return serialize(await loadOwnedInterview(userId, interviewId));
}

export async function listMockInterviews(userId, courseId) {
  const rows = await prisma.mockInterview.findMany({
    where: { userId, ...(courseId ? { courseId } : {}) },
    orderBy: { startedAt: "desc" },
    take: 20,
  });
  return rows.map(serialize);
}
