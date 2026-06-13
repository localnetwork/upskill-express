import path from "path";
import { Readable } from "stream";
import { Router } from "express";
import { prisma } from "../../shared/database/prisma.js";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { cacheGetResponse } from "../../shared/middleware/cache.middleware.js";
import { upload } from "../../shared/middleware/upload.middleware.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getObjectFromR2, isR2Enabled, isR2StoragePath } from "../../shared/storage/r2.js";
import { updateLessonProgress } from "../progress/progress.service.js";

const router = Router();
const QUIZ_ATTEMPT_KEY_PREFIX = "quiz_attempt::";

router.use(
  cacheGetResponse({
    prefix: "legacy:get",
    ttlSeconds: 60,
    varyByUser: true,
    tags: ["legacy", "courses", "users", "orders", "payouts", "notifications"],
  }),
);

function mediaPath(file) {
  if (!file) return null;
  if (file.path) return file.path;
  return file.filename ? `/uploads/${file.filename}` : null;
}

function normalizeExtendedProfile(payload = {}) {
  return {
    headline: payload.headline || "",
    biography: payload.biography || "",
    link_website: payload.link_website || "",
    link_facebook: payload.link_facebook || "",
    link_instagram: payload.link_instagram || "",
    link_linkedin: payload.link_linkedin || "",
    link_tiktok: payload.link_tiktok || "",
    link_x: payload.link_x || "",
    link_youtube: payload.link_youtube || "",
    link_github: payload.link_github || "",
  };
}

function pickLatestMediaByTypes(mediaList = [], types = []) {
  return mediaList.find((item) => types.includes(item.mediaType)) || null;
}

function mapLegacyMedia(media) {
  if (!media) return null;
  return {
    id: media.id,
    path: media.storagePath,
    title: media.originalName,
  };
}

function mapLessonTypeToLegacyResource(type, lesson) {
  if (type === "QUIZ") return "quiz";
  if (type === "CODING_EXERCISE") return "coding_exercise";
  if (type === "VIDEO" || lesson.videoUrl) return "video";
  if (lesson.assignmentText) return "article";
  return "null";
}

function parseJsonOrNull(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function mapLessonToLegacyCurriculum(lesson) {
  const parsedCodingStarterCode = parseJsonOrNull(lesson.codingStarterCode);
  const parsedQuizQuestions = parseJsonOrNull(lesson.quizQuestions);

  return {
    id: lesson.id,
    uuid: lesson.id,
    title: lesson.title,
    curriculum_type:
      lesson.type === "QUIZ"
        ? "quiz"
        : lesson.type === "CODING_EXERCISE"
          ? "coding_exercise"
          : lesson.type === "ASSIGNMENT"
            ? "assignment"
            : "lecture",
    curriculum_description: lesson.description || "",
    curriculum_resource_type: mapLessonTypeToLegacyResource(lesson.type, lesson),
    estimated_duration: lesson.durationInSeconds || 0,
    asset:
      lesson.type === "QUIZ"
        ? {
            questions: Array.isArray(parsedQuizQuestions)
              ? parsedQuizQuestions
              : parsedQuizQuestions?.questions || [],
          }
        : lesson.type === "CODING_EXERCISE"
          ? {
              instructions: lesson.codingInstructions || "",
              starter_code:
                parsedCodingStarterCode?.starter_code || parsedCodingStarterCode || {},
              expected_output: parsedCodingStarterCode?.expected_output || {},
              languages: parsedCodingStarterCode?.languages || [],
            }
          : lesson.videoUrl
            ? { path: lesson.videoUrl }
            : lesson.assignmentText
              ? { content: lesson.assignmentText }
              : null,
  };
}

async function ensureEducatorOwnsCourse(userId, courseId) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, educatorId: userId, deletedAt: null },
  });
  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  return course;
}

async function ensureEducatorOwnsSection(userId, sectionId) {
  const section = await prisma.courseSection.findFirst({
    where: {
      id: sectionId,
      course: {
        educatorId: userId,
        deletedAt: null,
      },
    },
    include: { course: true },
  });
  if (!section) {
    throw new ApiError(404, "Section not found");
  }
  return section;
}

async function ensureEducatorOwnsLesson(userId, lessonId) {
  const lesson = await prisma.lesson.findFirst({
    where: {
      id: lessonId,
      course: {
        educatorId: userId,
        deletedAt: null,
      },
    },
    include: { course: true },
  });
  if (!lesson) {
    throw new ApiError(404, "Curriculum not found");
  }
  return lesson;
}

async function ensureLearnerOwnsQuizLesson(userId, lessonId) {
  const lesson = await prisma.lesson.findUnique({
    where: { id: String(lessonId) },
    include: {
      course: true,
    },
  });

  if (!lesson || !lesson.course || lesson.course.deletedAt) {
    throw new ApiError(404, "Lesson not found");
  }

  const enrollment = await prisma.enrollment.findFirst({
    where: {
      userId,
      courseId: lesson.courseId,
      status: "ACTIVE",
    },
  });

  if (!enrollment) {
    throw new ApiError(403, "Not enrolled in this course");
  }

  if (lesson.type !== "QUIZ") {
    throw new ApiError(400, "This lesson is not a quiz");
  }

  return { lesson, enrollment };
}

function getQuizAttemptSettingKey(userId, lessonId) {
  return `${QUIZ_ATTEMPT_KEY_PREFIX}${userId}::${lessonId}`;
}

function parseJsonOrDefault(value, fallback) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function normalizeQuizPayload(quizQuestions) {
  const parsed = parseJsonOrDefault(quizQuestions, {});
  const rawQuestions = Array.isArray(parsed) ? parsed : parsed.questions || [];
  const settings = {
    passingScore: Number(parsed?.settings?.passingScore || 80),
    allowSkip: Boolean(parsed?.settings?.allowSkip || false),
    hintPenalty: Number(parsed?.settings?.hintPenalty || 1),
    allowRetakeAfterPass: Boolean(parsed?.settings?.allowRetakeAfterPass || false),
    quizTimerSeconds: Number(parsed?.settings?.quizTimerSeconds || 0),
  };

  return {
    questions: rawQuestions.map((question, index) => ({
      ...question,
      id: question?.id || `q-${index + 1}`,
      type: question?.type || "multiple_choice",
      prompt: question?.prompt || "",
      explanation: question?.explanation || "",
      hint: question?.hint || "",
      points: Number(question?.points || 10),
    })),
    settings,
  };
}

function getCorrectAnswerPayload(question) {
  if (question.type === "multiple_choice") {
    const indices = (question.options || [])
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => Boolean(option?.isCorrect))
      .map(({ index }) => index);
    return indices;
  }

  if (question.type === "true_false") {
    return Boolean(question.correctAnswer);
  }

  if (question.type === "fill_in_the_blanks" || question.type === "short_answer") {
    return (question.acceptedAnswers || []).map((value) => String(value || "").trim().toLowerCase());
  }

  return null;
}

function validateAnswer(question, submittedAnswer) {
  const correctAnswer = getCorrectAnswerPayload(question);

  if (question.type === "multiple_choice") {
    const expected = Array.isArray(correctAnswer) ? correctAnswer : [];
    const selected = Array.isArray(submittedAnswer)
      ? submittedAnswer.map((value) => Number(value))
      : [Number(submittedAnswer)];
    const selectedUnique = Array.from(new Set(selected)).sort((a, b) => a - b);
    const expectedUnique = Array.from(new Set(expected)).sort((a, b) => a - b);
    const isCorrect =
      selectedUnique.length === expectedUnique.length &&
      selectedUnique.every((value, index) => value === expectedUnique[index]);
    return { isCorrect, correctAnswer: expectedUnique };
  }

  if (question.type === "true_false") {
    const normalized = String(submittedAnswer).toLowerCase() === "true";
    return { isCorrect: normalized === Boolean(correctAnswer), correctAnswer: Boolean(correctAnswer) };
  }

  if (question.type === "fill_in_the_blanks" || question.type === "short_answer") {
    const normalized = String(submittedAnswer || "").trim().toLowerCase();
    const accepted = Array.isArray(correctAnswer) ? correctAnswer : [];
    return { isCorrect: accepted.includes(normalized), correctAnswer: accepted };
  }

  return { isCorrect: false, correctAnswer: null };
}

function computeQuizMetrics(state, totalQuestions, passingScore) {
  const resultEntries = Object.values(state.questionResults || {});
  const answeredQuestions = resultEntries.length;
  const correctAnswers = resultEntries.filter((item) => item?.isCorrect).length;
  const incorrectAnswers = answeredQuestions - correctAnswers;
  const hintsUsed = Object.values(state.hintUsage || {}).filter(Boolean).length;
  const score = resultEntries.reduce((sum, item) => sum + Number(item?.awardedPoints || 0), 0);
  const maxScore = resultEntries.reduce((sum, item) => sum + Number(item?.maxPoints || 0), 0);
  const scorePercentage = maxScore > 0 ? Number(((score / maxScore) * 100).toFixed(2)) : 0;
  const completionPercentage =
    totalQuestions > 0 ? Number(((answeredQuestions / totalQuestions) * 100).toFixed(2)) : 0;
  const completed = answeredQuestions >= totalQuestions && totalQuestions > 0;
  const passed = completed ? scorePercentage >= passingScore : false;
  const startedAt = state.startedAt ? new Date(state.startedAt) : new Date();
  const lastActivityAt = state.lastActivityAt ? new Date(state.lastActivityAt) : new Date();
  const timeSpentSeconds = Math.max(
    0,
    Math.floor((lastActivityAt.getTime() - startedAt.getTime()) / 1000),
  );

  return {
    totalQuestions,
    answeredQuestions,
    correctAnswers,
    incorrectAnswers,
    hintsUsed,
    score,
    maxScore,
    scorePercentage,
    completionPercentage,
    completed,
    passed,
    timeSpentSeconds,
  };
}

function buildDefaultQuizState(quizPayload) {
  return {
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    currentQuestionIndex: 0,
    answers: {},
    hintUsage: {},
    questionResults: {},
    metrics: computeQuizMetrics({ questionResults: {}, hintUsage: {} }, quizPayload.questions.length, quizPayload.settings.passingScore),
    completed: false,
    passed: false,
    attemptNumber: 1,
    attemptHistory: [],
    completionRecorded: false,
  };
}

async function loadQuizAttemptState(userId, lesson) {
  const quizPayload = normalizeQuizPayload(lesson.quizQuestions);
  const key = getQuizAttemptSettingKey(userId, lesson.id);
  const setting = await prisma.platformSetting.findUnique({
    where: { key },
    select: { value: true },
  });

  const saved = parseJsonOrDefault(setting?.value, null);
  const baseState = saved || buildDefaultQuizState(quizPayload);
  const state = {
    ...buildDefaultQuizState(quizPayload),
    ...baseState,
    lastActivityAt: new Date().toISOString(),
  };
  state.metrics = computeQuizMetrics(
    state,
    quizPayload.questions.length,
    quizPayload.settings.passingScore,
  );
  state.completed = state.metrics.completed;
  state.passed = state.metrics.passed;

  return { key, quizPayload, state };
}

async function saveQuizAttemptState(key, state) {
  await prisma.platformSetting.upsert({
    where: { key },
    create: { key, value: JSON.stringify(state) },
    update: { value: JSON.stringify(state) },
  });
}

async function finalizeQuizCompletion(userId, lessonId, state, quizPayload) {
  const metrics = computeQuizMetrics(state, quizPayload.questions.length, quizPayload.settings.passingScore);
  state.metrics = metrics;
  state.completed = metrics.completed;
  state.passed = metrics.passed;

  if (!metrics.completed) {
    return state;
  }

  if (!state.completionRecorded) {
    state.attemptHistory = Array.isArray(state.attemptHistory) ? state.attemptHistory : [];
    state.attemptHistory.push({
      attemptNumber: state.attemptNumber || 1,
      completedAt: new Date().toISOString(),
      passed: metrics.passed,
      score: metrics.score,
      scorePercentage: metrics.scorePercentage,
      correctAnswers: metrics.correctAnswers,
      incorrectAnswers: metrics.incorrectAnswers,
      hintsUsed: metrics.hintsUsed,
      completionPercentage: metrics.completionPercentage,
      timeSpentSeconds: metrics.timeSpentSeconds,
    });
    state.completionRecorded = true;
  }

  await updateLessonProgress(userId, {
    lessonId,
    progressPct: metrics.passed ? 100 : metrics.scorePercentage,
    isCompleted: metrics.passed,
    lastPosition: 0,
  });

  return state;
}

async function canAccessCourseMedia(userId, courseId) {
  const [course, enrollment] = await Promise.all([
    prisma.course.findFirst({
      where: {
        id: courseId,
        educatorId: userId,
        deletedAt: null,
      },
      select: { id: true },
    }),
    prisma.enrollment.findFirst({
      where: {
        userId,
        courseId,
        status: "ACTIVE",
      },
      select: { id: true },
    }),
  ]);

  return Boolean(course || enrollment);
}

async function resolveLessonVideoById(id) {
  const lesson = await prisma.lesson.findUnique({
    where: { id: String(id) },
    include: {
      media: {
        where: { mediaType: "VIDEO" },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });

  if (!lesson) {
    return null;
  }

  const storagePath = lesson.videoUrl || lesson.media?.[0]?.storagePath || null;
  return {
    courseId: lesson.courseId,
    storagePath,
  };
}

async function resolveMediaSourceByQueryId(id) {
  const media = await prisma.media.findUnique({
    where: { id: String(id) },
    include: {
      lesson: {
        select: { courseId: true },
      },
    },
  });

  if (media) {
    return {
      userId: media.userId,
      courseId: media.lesson?.courseId || media.courseId || null,
      storagePath: media.storagePath,
    };
  }

  const lessonVideo = await resolveLessonVideoById(id);
  if (lessonVideo) {
    return {
      userId: null,
      courseId: lessonVideo.courseId,
      storagePath: lessonVideo.storagePath,
    };
  }

  return null;
}

async function sendMediaStoragePath(storagePath, res) {
  if (!storagePath) {
    throw new ApiError(404, "Video file not found");
  }

  res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", "inline");

  if (isR2Enabled() && isR2StoragePath(storagePath)) {
    const object = await getObjectFromR2(storagePath);
    if (!object.body) {
      throw new ApiError(404, "Video file not found");
    }
    res.setHeader("Content-Type", object.contentType);
    if (object.contentLength) {
      res.setHeader("Content-Length", String(object.contentLength));
    }
    if (typeof object.body.pipe === "function") {
      object.body.pipe(res);
      return;
    }

    if (typeof object.body.transformToWebStream === "function") {
      Readable.fromWeb(object.body.transformToWebStream()).pipe(res);
      return;
    }

    if (typeof object.body.transformToByteArray === "function") {
      const bytes = await object.body.transformToByteArray();
      res.end(Buffer.from(bytes));
      return;
    }

    throw new ApiError(500, "Unsupported media stream format from storage");
  }

  if (/^https?:\/\//i.test(storagePath)) {
    res.redirect(storagePath);
    return;
  }

  const absolutePath = path.resolve(storagePath.replace(/^\//, ""));
  res.sendFile(absolutePath);
}

router.get("/user/:slug", async (req, res, next) => {
  try {
    const user = await prisma.user.findFirst({
      where: {
        username: req.params.slug,
        deletedAt: null,
      },
      include: {
        roles: {
          include: { role: true },
        },
      },
    });

    if (!user) {
      throw new ApiError(404, "User not found");
    }

    const extended = normalizeExtendedProfile(user);

    return res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      firstname: user.firstName || "",
      lastname: user.lastName || "",
      firstName: user.firstName || "",
      lastName: user.lastName || "",
      biography: extended.biography,
      headline: extended.headline,
      link_website: extended.link_website,
      link_facebook: extended.link_facebook,
      link_instagram: extended.link_instagram,
      link_linkedin: extended.link_linkedin,
      link_tiktok: extended.link_tiktok,
      link_x: extended.link_x,
      link_youtube: extended.link_youtube,
      link_github: extended.link_github,
      roles: user.roles.map((item) => ({
        role_name:
          item.role.name === "EDUCATOR"
            ? "Instructor"
            : item.role.name === "LEARNER"
              ? "Learner"
              : item.role.name,
      })),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/instructor/courses/:userId", async (req, res, next) => {
  try {
    const courses = await prisma.course.findMany({
      where: {
        educatorId: req.params.userId,
        workflowStatus: "PUBLISHED",
        deletedAt: null,
      },
      include: {
        educator: {
          select: { id: true, username: true, firstName: true, lastName: true },
        },
        level: true,
        priceTier: true,
        media: {
          where: {
            mediaType: { in: ["COVER_IMAGE", "IMAGE", "PROMO_VIDEO"] },
          },
          orderBy: { createdAt: "desc" },
        },
        sections: { include: { lessons: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const data = courses.map((course) => ({
      ...course,
      uuid: course.id,
      cover_image: mapLegacyMedia(
        pickLatestMediaByTypes(course.media, ["COVER_IMAGE", "IMAGE"]),
      ),
      promo_video: mapLegacyMedia(
        pickLatestMediaByTypes(course.media, ["PROMO_VIDEO"]),
      ),
      instructional_level: course.level
        ? { id: course.level.id, title: course.level.title }
        : null,
      price_tier: course.priceTier
        ? {
            id: course.priceTier.id,
            title: course.priceTier.title,
            price: String(course.priceTier.price),
          }
        : null,
      author: {
        data: {
          id: course.educator.id,
          username: course.educator.username,
          firstname: course.educator.firstName || "",
          lastname: course.educator.lastName || "",
          user_picture: null,
        },
      },
      resources_count: {
        section_count: course.sections.length,
        curriculum_count: course.sections.reduce((acc, section) => acc + section.lessons.length, 0),
      },
    }));

    return res.json({ data });
  } catch (error) {
    return next(error);
  }
});

router.put("/profile", authenticate, async (req, res, next) => {
  try {
    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        firstName:
          req.body.firstName === undefined ? req.body.firstname : req.body.firstName,
        lastName:
          req.body.lastName === undefined ? req.body.lastname : req.body.lastName,
        headline: req.body.headline === undefined ? undefined : req.body.headline,
        biography: req.body.biography === undefined ? undefined : req.body.biography,
        link_website: req.body.link_website === undefined ? undefined : req.body.link_website,
        link_facebook:
          req.body.link_facebook === undefined ? undefined : req.body.link_facebook,
        link_instagram:
          req.body.link_instagram === undefined ? undefined : req.body.link_instagram,
        link_linkedin:
          req.body.link_linkedin === undefined ? undefined : req.body.link_linkedin,
        link_tiktok: req.body.link_tiktok === undefined ? undefined : req.body.link_tiktok,
        link_x: req.body.link_x === undefined ? undefined : req.body.link_x,
        link_youtube:
          req.body.link_youtube === undefined ? undefined : req.body.link_youtube,
        link_github: req.body.link_github === undefined ? undefined : req.body.link_github,
      },
    });

    const extended = normalizeExtendedProfile(updatedUser);
    return res.json({
      message: "Profile updated",
      data: {
        id: updatedUser.id,
        firstname: updatedUser.firstName || "",
        lastname: updatedUser.lastName || "",
        firstName: updatedUser.firstName || "",
        lastName: updatedUser.lastName || "",
        ...extended,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.put("/profile/user-picture", authenticate, async (req, res, next) => {
  try {
    const mediaId = req.body.user_picture ? String(req.body.user_picture) : null;
    if (!mediaId) {
      throw new ApiError(400, "user_picture is required");
    }

    const media = await prisma.media.findFirst({
      where: {
        id: mediaId,
        userId: req.user.id,
      },
      select: {
        id: true,
        storagePath: true,
      },
    });

    if (!media) {
      throw new ApiError(404, "Media not found");
    }

    return res.json({
      message: "Profile image linked",
      data: { id: media.id, path: media.storagePath },
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/media", authenticate, upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) {
      throw new ApiError(400, "File is required");
    }

    const media = await prisma.media.create({
      data: {
        userId: req.user.id,
        storagePath: mediaPath(req.file),
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        mediaType: "IMAGE",
        sizeInBytes: req.file.size,
      },
    });
    return res.status(201).json({
      id: media.id,
      path: media.storagePath,
      title: media.originalName,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/videos", authenticate, upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) {
      throw new ApiError(400, "File is required");
    }

    const media = await prisma.media.create({
      data: {
        userId: req.user.id,
        storagePath: mediaPath(req.file),
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        mediaType: "VIDEO",
        sizeInBytes: req.file.size,
      },
    });
    return res.status(201).json({
      id: media.id,
      path: media.storagePath,
      title: media.originalName,
    });
  } catch (error) {
    return next(error);
  }
});

router.post(
  "/courses/:courseId/promo-video",
  authenticate,
  authorize("EDUCATOR"),
  upload.single("promo_video"),
  async (req, res, next) => {
    try {
      const courseId = req.params.courseId;
      await ensureEducatorOwnsCourse(req.user.id, courseId);

      if (!req.file) {
        throw new ApiError(400, "File is required");
      }

      const media = await prisma.media.create({
        data: {
          userId: req.user.id,
          courseId,
          storagePath: mediaPath(req.file),
          originalName: req.file.originalname,
          mimeType: req.file.mimetype,
          mediaType: "PROMO_VIDEO",
          sizeInBytes: req.file.size,
        },
      });

      return res.status(201).json({
        id: media.id,
        path: media.storagePath,
        title: media.originalName,
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.get(
  "/course-sections/course/:courseId",
  authenticate,
  authorize("EDUCATOR"),
  async (req, res, next) => {
    try {
      await ensureEducatorOwnsCourse(req.user.id, req.params.courseId);
      const sections = await prisma.courseSection.findMany({
        where: { courseId: req.params.courseId },
        orderBy: { position: "asc" },
      });
      return res.json(
        sections.map((section) => ({
          ...section,
          section_description: section.description || "",
        })),
      );
    } catch (error) {
      return next(error);
    }
  },
);

router.post("/course-sections", authenticate, authorize("EDUCATOR"), async (req, res, next) => {
  try {
    const courseId = req.body.course_id;
    await ensureEducatorOwnsCourse(req.user.id, courseId);

    const lastSection = await prisma.courseSection.findFirst({
      where: { courseId },
      orderBy: { position: "desc" },
    });

    const section = await prisma.courseSection.create({
      data: {
        courseId,
        title: req.body.title,
        description: req.body.description || "",
        position: (lastSection?.position || 0) + 1,
      },
    });

    return res.status(201).json({
      data: {
        ...section,
        section_description: section.description || "",
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.put("/course-sections/:sectionId", authenticate, authorize("EDUCATOR"), async (req, res, next) => {
  try {
    const section = await ensureEducatorOwnsSection(req.user.id, req.params.sectionId);

    const updated = await prisma.courseSection.update({
      where: { id: section.id },
      data: {
        title: req.body.title,
        description: req.body.description || "",
      },
    });

    return res.json({
      data: {
        ...updated,
        section_description: updated.description || "",
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.delete(
  "/course-sections/:sectionId",
  authenticate,
  authorize("EDUCATOR"),
  async (req, res, next) => {
    try {
      const section = await ensureEducatorOwnsSection(req.user.id, req.params.sectionId);
      await prisma.courseSection.delete({ where: { id: section.id } });
      return res.json({ success: true });
    } catch (error) {
      return next(error);
    }
  },
);

router.get(
  "/course-sections/:sectionId/curriculums",
  authenticate,
  authorize("EDUCATOR"),
  async (req, res, next) => {
    try {
      const section = await ensureEducatorOwnsSection(req.user.id, req.params.sectionId);
      const lessons = await prisma.lesson.findMany({
        where: { sectionId: section.id },
        orderBy: { position: "asc" },
      });
      return res.json({
        data: lessons.map(mapLessonToLegacyCurriculum),
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.put(
  "/course-sections/:sectionId/curriculums/sort",
  authenticate,
  authorize("EDUCATOR"),
  async (req, res, next) => {
    try {
      const section = await ensureEducatorOwnsSection(req.user.id, req.params.sectionId);
      const itemIds = Array.isArray(req.body.items) ? req.body.items : [];
      await prisma.$transaction(
        itemIds.map((id, index) =>
          prisma.lesson.updateMany({
            where: { id, sectionId: section.id },
            data: { position: index + 1 },
          }),
        ),
      );
      return res.json({ success: true });
    } catch (error) {
      return next(error);
    }
  },
);

router.post("/course-curriculums", authenticate, authorize("EDUCATOR"), async (req, res, next) => {
  try {
    const section = await ensureEducatorOwnsSection(req.user.id, req.body.course_section_id);
    const lesson = await prisma.lesson.create({
      data: {
        sectionId: section.id,
        courseId: section.courseId,
        type:
          req.body.curriculum_type === "quiz"
            ? "QUIZ"
            : req.body.curriculum_type === "coding_exercise"
              ? "CODING_EXERCISE"
              : req.body.curriculum_type === "assignment"
                ? "ASSIGNMENT"
                : "RESOURCE",
        title: req.body.title,
        description: req.body.description || "",
        position:
          ((await prisma.lesson.findFirst({
            where: { sectionId: section.id },
            orderBy: { position: "desc" },
          }))?.position || 0) + 1,
      },
    });

    return res.status(201).json({ data: mapLessonToLegacyCurriculum(lesson) });
  } catch (error) {
    return next(error);
  }
});

router.put("/course-curriculums/:lessonId", authenticate, authorize("EDUCATOR"), async (req, res, next) => {
  try {
    const lesson = await ensureEducatorOwnsLesson(req.user.id, req.params.lessonId);
    const quizQuestions =
      req.body.quizQuestions !== undefined ? req.body.quizQuestions : req.body.quiz_questions;
    const codingInstructions =
      req.body.codingInstructions !== undefined
        ? req.body.codingInstructions
        : req.body.coding_instructions;
    const codingStarterCode =
      req.body.codingStarterCode !== undefined
        ? req.body.codingStarterCode
        : req.body.coding_starter_code;

    const data = {
      title: req.body.title,
      description: req.body.description || "",
    };

    if (quizQuestions !== undefined) {
      data.quizQuestions = quizQuestions;
    }

    if (codingInstructions !== undefined) {
      data.codingInstructions = String(codingInstructions || "");
    }

    if (codingStarterCode !== undefined) {
      data.codingStarterCode =
        typeof codingStarterCode === "string"
          ? codingStarterCode
          : JSON.stringify(codingStarterCode || {});
    }

    const updated = await prisma.lesson.update({
      where: { id: lesson.id },
      data,
    });
    return res.json({ data: mapLessonToLegacyCurriculum(updated) });
  } catch (error) {
    return next(error);
  }
});

router.delete(
  "/course-curriculums/:lessonId",
  authenticate,
  authorize("EDUCATOR"),
  async (req, res, next) => {
    try {
      const lesson = await ensureEducatorOwnsLesson(req.user.id, req.params.lessonId);
      await prisma.lesson.delete({ where: { id: lesson.id } });
      return res.json({ success: true });
    } catch (error) {
      return next(error);
    }
  },
);

router.post("/course-curriculums/add-progress", authenticate, async (req, res, next) => {
  try {
    const data = await updateLessonProgress(req.user.id, {
      lessonId: req.body.curriculum_id,
      progressPct: 100,
      isCompleted: true,
      lastPosition: 0,
    });
    return res.json({ data });
  } catch (error) {
    return next(error);
  }
});

router.get("/course-curriculums/:lessonId/quiz-attempt", authenticate, authorize("LEARNER"), async (req, res, next) => {
  try {
    const { lesson } = await ensureLearnerOwnsQuizLesson(req.user.id, req.params.lessonId);
    const { key, quizPayload, state } = await loadQuizAttemptState(req.user.id, lesson);
    await saveQuizAttemptState(key, state);

    return res.json({
      data: {
        lessonId: lesson.id,
        settings: quizPayload.settings,
        totalQuestions: quizPayload.questions.length,
        state,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/course-curriculums/:lessonId/quiz-attempt/hint", authenticate, authorize("LEARNER"), async (req, res, next) => {
  try {
    const questionIndex = Number(req.body.questionIndex);
    if (!Number.isInteger(questionIndex) || questionIndex < 0) {
      throw new ApiError(400, "Invalid questionIndex");
    }

    const { lesson } = await ensureLearnerOwnsQuizLesson(req.user.id, req.params.lessonId);
    const { key, quizPayload, state } = await loadQuizAttemptState(req.user.id, lesson);
    const question = quizPayload.questions[questionIndex];
    if (!question) {
      throw new ApiError(404, "Question not found");
    }
    if (state.completed) {
      throw new ApiError(400, "Quiz already completed");
    }

    const questionKey = question.id || `q-${questionIndex + 1}`;
    const alreadyUsed = Boolean(state.hintUsage?.[questionKey]);
    if (!alreadyUsed) {
      state.hintUsage = state.hintUsage || {};
      state.hintUsage[questionKey] = true;
      state.lastActivityAt = new Date().toISOString();
      state.metrics = computeQuizMetrics(state, quizPayload.questions.length, quizPayload.settings.passingScore);
      await saveQuizAttemptState(key, state);
    }

    return res.json({
      data: {
        questionIndex,
        hint: question.hint || "Focus on key concepts in the question prompt and eliminate unlikely options.",
        alreadyUsed,
        hintUsed: true,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/course-curriculums/:lessonId/quiz-attempt/validate", authenticate, authorize("LEARNER"), async (req, res, next) => {
  try {
    const questionIndex = Number(req.body.questionIndex);
    if (!Number.isInteger(questionIndex) || questionIndex < 0) {
      throw new ApiError(400, "Invalid questionIndex");
    }

    const { lesson } = await ensureLearnerOwnsQuizLesson(req.user.id, req.params.lessonId);
    const { key, quizPayload, state } = await loadQuizAttemptState(req.user.id, lesson);
    if (state.completed) {
      throw new ApiError(400, "Quiz already completed");
    }

    if (!quizPayload.settings.allowSkip && questionIndex !== Number(state.currentQuestionIndex || 0)) {
      throw new ApiError(400, "You must answer questions in order");
    }

    const question = quizPayload.questions[questionIndex];
    if (!question) {
      throw new ApiError(404, "Question not found");
    }

    const questionKey = question.id || `q-${questionIndex + 1}`;
    const submittedAnswer = req.body.answer;
    const validation = validateAnswer(question, submittedAnswer);
    const hintUsed = Boolean(state.hintUsage?.[questionKey]);
    const maxPoints = Number(question.points || 10);
    const deduction = hintUsed ? Number(quizPayload.settings.hintPenalty || 0) : 0;
    const awardedPoints = validation.isCorrect ? Math.max(0, maxPoints - deduction) : 0;

    state.answers = state.answers || {};
    state.answers[questionKey] = submittedAnswer;
    state.questionResults = state.questionResults || {};
    state.questionResults[questionKey] = {
      questionIndex,
      submittedAnswer,
      isCorrect: validation.isCorrect,
      correctAnswer: validation.correctAnswer,
      explanation: question.explanation || "Review this concept before your next attempt.",
      awardedPoints,
      maxPoints,
      hintUsed,
      answeredAt: new Date().toISOString(),
    };

    if (!quizPayload.settings.allowSkip) {
      state.currentQuestionIndex = Math.min(questionIndex + 1, Math.max(quizPayload.questions.length - 1, 0));
    } else {
      state.currentQuestionIndex = Number(req.body.nextQuestionIndex ?? questionIndex + 1);
    }
    state.lastActivityAt = new Date().toISOString();

    await finalizeQuizCompletion(req.user.id, lesson.id, state, quizPayload);
    await saveQuizAttemptState(key, state);

    return res.json({
      data: {
        questionIndex,
        validation: state.questionResults[questionKey],
        metrics: state.metrics,
        completed: state.completed,
        passed: state.passed,
        nextQuestionIndex: state.currentQuestionIndex,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/course-curriculums/:lessonId/quiz-attempt/retry", authenticate, authorize("LEARNER"), async (req, res, next) => {
  try {
    const { lesson } = await ensureLearnerOwnsQuizLesson(req.user.id, req.params.lessonId);
    const { key, quizPayload, state } = await loadQuizAttemptState(req.user.id, lesson);

    if (state.passed && !quizPayload.settings.allowRetakeAfterPass) {
      throw new ApiError(400, "Retake is not allowed for this quiz");
    }

    const nextAttemptNumber = Number(state.attemptNumber || 1) + 1;
    const resetState = {
      ...buildDefaultQuizState(quizPayload),
      attemptNumber: nextAttemptNumber,
      attemptHistory: Array.isArray(state.attemptHistory) ? state.attemptHistory : [],
    };

    await saveQuizAttemptState(key, resetState);

    return res.json({
      data: {
        lessonId: lesson.id,
        settings: quizPayload.settings,
        totalQuestions: quizPayload.questions.length,
        state: resetState,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post(
  "/course-resources/videos",
  authenticate,
  authorize("EDUCATOR"),
  upload.single("file"),
  async (req, res, next) => {
    try {
      const lesson = await ensureEducatorOwnsLesson(req.user.id, req.body.curriculum_id);
      if (!req.file) {
        throw new ApiError(400, "File is required");
      }

      const videoPath = mediaPath(req.file);
      const media = await prisma.media.create({
        data: {
          userId: req.user.id,
          courseId: lesson.courseId,
          lessonId: lesson.id,
          storagePath: videoPath,
          originalName: req.file.originalname,
          mimeType: req.file.mimetype,
          mediaType: "VIDEO",
          sizeInBytes: req.file.size,
        },
      });

      const updatedLesson = await prisma.lesson.update({
        where: { id: lesson.id },
        data: {
          videoUrl: videoPath,
          durationInSeconds: Number(req.body.duration || 0),
        },
      });

      return res.status(201).json({
        data: {
          curriculum: mapLessonToLegacyCurriculum(updatedLesson),
          asset: { id: media.id, path: videoPath },
        },
        path: videoPath,
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.get("/stream.php", authenticate, async (req, res, next) => {
  try {
    const fetchDest = String(req.get("sec-fetch-dest") || "").toLowerCase();
    if (fetchDest === "document") {
      throw new ApiError(403, "Direct page access is not allowed");
    }

    const queryId = req.query.id;
    if (!queryId) {
      throw new ApiError(400, "Missing media id");
    }

    const mediaSource = await resolveMediaSourceByQueryId(queryId);
    if (!mediaSource) {
      throw new ApiError(404, "Media not found");
    }

    if (mediaSource.courseId) {
      const allowed = await canAccessCourseMedia(req.user.id, mediaSource.courseId);
      if (!allowed) {
        throw new ApiError(403, "Not allowed to access this media");
      }
    } else if (mediaSource.userId && mediaSource.userId !== req.user.id) {
      throw new ApiError(403, "Not allowed to access this media");
    }

    await sendMediaStoragePath(mediaSource.storagePath, res);
    return;
  } catch (error) {
    return next(error);
  }
});

router.delete(
  "/course-resources/videos/:lessonId",
  authenticate,
  authorize("EDUCATOR"),
  async (req, res, next) => {
    try {
      const lesson = await ensureEducatorOwnsLesson(req.user.id, req.params.lessonId);
      const updatedLesson = await prisma.lesson.update({
        where: { id: lesson.id },
        data: { videoUrl: null },
      });
      return res.json({
        data: {
          curriculum: mapLessonToLegacyCurriculum(updatedLesson),
          asset: null,
        },
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post("/course-resources/articles", authenticate, authorize("EDUCATOR"), async (req, res, next) => {
  try {
    const lesson = await ensureEducatorOwnsLesson(req.user.id, req.body.curriculum_id);
    const updatedLesson = await prisma.lesson.update({
      where: { id: lesson.id },
      data: {
        assignmentText: req.body.content,
      },
    });

    return res.status(201).json({
      data: {
        curriculum: mapLessonToLegacyCurriculum(updatedLesson),
        asset: { content: updatedLesson.assignmentText || "" },
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.delete(
  "/course-resources/articles/:lessonId",
  authenticate,
  authorize("EDUCATOR"),
  async (req, res, next) => {
    try {
      const lesson = await ensureEducatorOwnsLesson(req.user.id, req.params.lessonId);
      const updatedLesson = await prisma.lesson.update({
        where: { id: lesson.id },
        data: {
          assignmentText: null,
        },
      });
      return res.json({
        data: {
          curriculum: mapLessonToLegacyCurriculum(updatedLesson),
          asset: null,
        },
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post("/payout-accounts/paypal", authenticate, authorize("EDUCATOR"), async (req, res, next) => {
  try {
    const account = await prisma.payoutAccount.upsert({
      where: { userId: req.user.id },
      update: {
        paypalEmail: req.body.email,
        paypalMerchantId: req.body.accountId || null,
        isVerified: true,
      },
      create: {
        userId: req.user.id,
        paypalEmail: req.body.email,
        paypalMerchantId: req.body.accountId || null,
        isVerified: true,
      },
    });

    return res.status(201).json({ data: account });
  } catch (error) {
    return next(error);
  }
});

router.get("/payout-accounts", authenticate, authorize("EDUCATOR"), async (req, res, next) => {
  try {
    const account = await prisma.payoutAccount.findUnique({
      where: { userId: req.user.id },
    });
    const data = account
      ? [
          {
            provider: "paypal",
            provider_email: account.paypalEmail,
            provider_account_id: account.paypalMerchantId,
            is_default: "1",
          },
        ]
      : [];
    return res.json(data);
  } catch (error) {
    return next(error);
  }
});

router.get("/2fa-status", authenticate, async (_req, res) => {
  return res.json({ enabled: false, setup_required: false });
});

router.post("/setup-2fa", authenticate, async (_req, res) => {
  return res.status(400).json({ message: "2FA is not enabled on this backend." });
});

router.post("/confirm-2fa", authenticate, async (_req, res) => {
  return res.status(400).json({ message: "2FA is not enabled on this backend." });
});

router.post("/verify-2fa", async (_req, res) => {
  return res.status(400).json({ message: "2FA is not enabled on this backend." });
});

router.post("/disable-2fa", authenticate, async (_req, res) => {
  return res.status(400).json({ message: "2FA is not enabled on this backend." });
});

router.post("/verify-backup-code", async (_req, res) => {
  return res.status(400).json({ message: "2FA is not enabled on this backend." });
});

router.post("/regenerate-backup-codes", authenticate, async (_req, res) => {
  return res.status(400).json({ message: "2FA is not enabled on this backend." });
});

export default router;
