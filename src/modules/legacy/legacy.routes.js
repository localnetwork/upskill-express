import path from "path";
import { Router } from "express";
import { prisma } from "../../shared/database/prisma.js";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { upload } from "../../shared/middleware/upload.middleware.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { updateLessonProgress } from "../progress/progress.service.js";

const router = Router();

function mediaPath(file) {
  if (!file) return null;
  return `/uploads/${file.filename}`;
}

function mapLessonTypeToLegacyResource(type, lesson) {
  if (type === "VIDEO" || lesson.videoUrl) return "video";
  if (lesson.assignmentText) return "article";
  return "null";
}

function mapLessonToLegacyCurriculum(lesson) {
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
    asset: lesson.videoUrl
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

    return res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      firstname: user.firstName || "",
      lastname: user.lastName || "",
      firstName: user.firstName || "",
      lastName: user.lastName || "",
      biography: "",
      headline: "",
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
        sections: { include: { lessons: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const data = courses.map((course) => ({
      ...course,
      uuid: course.id,
      cover_image: null,
      promo_video: null,
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
    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        firstName: req.body.firstname || req.body.firstName || undefined,
        lastName: req.body.lastname || req.body.lastName || undefined,
      },
    });
    return res.json({
      message: "Profile updated",
      data: {
        id: updated.id,
        firstname: updated.firstName || "",
        lastname: updated.lastName || "",
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.put("/profile/user-picture", authenticate, async (req, res) => {
  return res.json({
    message: "Profile image linked",
    data: { id: req.body.user_picture || null, path: null },
  });
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
    const updated = await prisma.lesson.update({
      where: { id: lesson.id },
      data: {
        title: req.body.title,
        description: req.body.description || "",
      },
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
    const mediaId = req.query.id;
    if (!mediaId) {
      throw new ApiError(400, "Missing media id");
    }

    const media = await prisma.media.findUnique({
      where: { id: String(mediaId) },
      include: {
        lesson: true,
      },
    });
    if (!media || !media.lesson) {
      throw new ApiError(404, "Media not found");
    }

    const enrollment = await prisma.enrollment.findFirst({
      where: {
        userId: req.user.id,
        courseId: media.lesson.courseId,
        status: "ACTIVE",
      },
    });
    if (!enrollment) {
      throw new ApiError(403, "Not enrolled in this course");
    }

    const absolutePath = path.resolve(media.storagePath.replace(/^\//, ""));
    return res.sendFile(absolutePath);
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
