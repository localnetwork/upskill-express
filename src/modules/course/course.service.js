import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";
import { slugify } from "../../shared/utils/slugify.js";

const COVER_MEDIA_TYPES = ["IMAGE", "COVER_IMAGE"];
const PROMO_MEDIA_TYPES = ["PROMO_VIDEO"];
const COURSE_GOALS_KEY_PREFIX = "course_goals::";

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

function getCourseGoalsSettingKey(courseId) {
  return `${COURSE_GOALS_KEY_PREFIX}${courseId}`;
}

function normalizeGoalsPayload(payload = {}) {
  const toList = (input) =>
    Array.isArray(input)
      ? input
          .map((item) => String(item ?? "").trim())
          .filter(Boolean)
      : [];

  return {
    what_you_will_learn_data: toList(payload.what_you_will_learn_data),
    requirements_data: toList(payload.requirements_data),
    who_should_attend_data: toList(payload.who_should_attend_data),
  };
}

async function readCourseGoals(courseId) {
  const setting = await prisma.platformSetting.findUnique({
    where: { key: getCourseGoalsSettingKey(courseId) },
    select: { value: true },
  });

  if (!setting?.value) {
    return normalizeGoalsPayload({});
  }

  try {
    const parsed = JSON.parse(setting.value);
    return normalizeGoalsPayload(parsed);
  } catch (_error) {
    throw new ApiError(500, "Stored course goals are invalid");
  }
}

function extractMediaId(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object" && value.id) return String(value.id).trim();
  return "";
}

function safeParseJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function getCourseInclude() {
  return {
    educator: {
      select: { id: true, username: true, firstName: true, lastName: true },
    },
    level: true,
    priceTier: true,
    sections: {
      include: {
        lessons: {
          select: { id: true, type: true },
        },
      },
    },
    media: {
      where: {
        mediaType: { in: [...COVER_MEDIA_TYPES, ...PROMO_MEDIA_TYPES] },
      },
      orderBy: { createdAt: "desc" },
    },
  };
}

function normalizeLevelTitle(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

async function resolveLevelId(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return null;
  }

  const value = String(rawValue).trim();
  if (!value || value === "0" || value === "4") {
    return null;
  }

  const byId = await prisma.courseLevel.findUnique({
    where: { id: value },
    select: { id: true },
  });
  if (byId) return byId.id;

  const numericValue = Number(value);
  if (Number.isInteger(numericValue) && numericValue > 0) {
    const byWeight = await prisma.courseLevel.findFirst({
      where: { weight: numericValue },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (byWeight) return byWeight.id;
  }

  const title = normalizeLevelTitle(value);
  if (title === "all levels" || title === "all") {
    return null;
  }

  if (title) {
    const byTitle = await prisma.courseLevel.findFirst({
      where: { title: { equals: value, mode: "insensitive" } },
      select: { id: true },
    });
    if (byTitle) return byTitle.id;
  }

  return null;
}

async function resolveCategoryId(payload) {
  const directCategoryId = payload.categoryId || payload.category_id || null;
  if (directCategoryId) return String(directCategoryId);

  const normalizeCategoryRef = (value) => {
    if (value === undefined || value === null) return "";
    if (typeof value === "string" || typeof value === "number") {
      return String(value).trim();
    }
    if (typeof value === "object") {
      return String(value.id || value.category_id || "").trim();
    }
    return "";
  };

  const categoryIds = Array.isArray(payload.category_ids)
    ? payload.category_ids
        .map(normalizeCategoryRef)
        .filter(Boolean)
    : [];

  if (categoryIds.length === 0) return null;

  const categories = await prisma.category.findMany({
    where: {
      id: { in: categoryIds },
      deletedAt: null,
    },
    select: { id: true, parentId: true },
  });

  if (!categories.length) return null;

  // Prefer the most specific (child) category when parent + child are both submitted.
  const child = categories.find((category) => category.parentId);
  return child?.id || categories[0].id;
}

async function normalizeCoursePayload(payload) {
  const categoryId = await resolveCategoryId(payload);
  const levelInput = payload.levelId || payload.instructional_level || null;
  const levelId = await resolveLevelId(levelInput);

  return {
    title: payload.title,
    subtitle: payload.subtitle,
    description: payload.description,
    categoryId,
    levelId,
    priceTierId: payload.priceTierId || payload.price_tier || null,
    isPublished:
      payload.published === undefined
        ? undefined
        : payload.published === true || payload.published === "1",
  };
}

async function makeUniqueSlug(title) {
  const base = slugify(title);
  const count = await prisma.course.count({
    where: { slug: { startsWith: base } },
  });
  return count > 0 ? `${base}-${count + 1}` : base;
}

export async function createCourse(userId, payload) {
  const slug = await makeUniqueSlug(payload.title);
  const normalized = await normalizeCoursePayload(payload);
  return prisma.course.create({
    data: {
      title: normalized.title,
      subtitle: normalized.subtitle,
      description: normalized.description,
      slug,
      language: payload.language || "en",
      categoryId: normalized.categoryId,
      levelId: normalized.levelId,
      priceTierId: normalized.priceTierId,
      educatorId: userId,
      isPublished: normalized.isPublished,
    },
  });
}

export async function updateCourse(userId, courseId, payload) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, deletedAt: null },
  });

  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  if (course.educatorId !== userId) {
    throw new ApiError(403, "You can only update your own course");
  }
  if (course.workflowStatus !== "DRAFT") {
    throw new ApiError(400, "Only draft courses can be updated");
  }

  const normalized = await normalizeCoursePayload(payload);

  return prisma.$transaction(async (tx) => {
    const updatedCourse = await tx.course.update({
      where: { id: courseId },
      data: normalized,
    });

    const coverImageId = extractMediaId(payload.cover_image);
    if (coverImageId) {
      await tx.media.updateMany({
        where: {
          id: coverImageId,
          userId,
          mediaType: { in: COVER_MEDIA_TYPES },
        },
        data: {
          courseId: updatedCourse.id,
          mediaType: "COVER_IMAGE",
        },
      });
    }

    const promoVideoId = extractMediaId(payload.promo_video);
    if (promoVideoId) {
      await tx.media.updateMany({
        where: {
          id: promoVideoId,
          userId,
          mediaType: { in: ["VIDEO", ...PROMO_MEDIA_TYPES] },
        },
        data: {
          courseId: updatedCourse.id,
          mediaType: "PROMO_VIDEO",
        },
      });
    }

    const hydratedCourse = await tx.course.findFirst({
      where: { id: updatedCourse.id },
      include: getCourseInclude(),
    });

    const coverImage = mapLegacyMedia(
      pickLatestMediaByTypes(hydratedCourse?.media, COVER_MEDIA_TYPES),
    );
    const promoVideo = mapLegacyMedia(
      pickLatestMediaByTypes(hydratedCourse?.media, PROMO_MEDIA_TYPES),
    );

    return {
      ...hydratedCourse,
      cover_image: coverImage,
      promo_video: promoVideo,
    };
  });
}

export async function updateCourseGoals(userId, courseId, payload) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, deletedAt: null },
  });
  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  if (course.educatorId !== userId) {
    throw new ApiError(403, "Forbidden");
  }

  const goals = normalizeGoalsPayload(payload);
  await prisma.platformSetting.upsert({
    where: { key: getCourseGoalsSettingKey(courseId) },
    update: {
      value: JSON.stringify(goals),
      description: `Goals for course ${courseId}`,
    },
    create: {
      key: getCourseGoalsSettingKey(courseId),
      value: JSON.stringify(goals),
      description: `Goals for course ${courseId}`,
    },
  });

  return goals;
}

export async function deleteDraftCourse(userId, courseId) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, deletedAt: null },
  });

  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  if (course.educatorId !== userId) {
    throw new ApiError(403, "Forbidden");
  }
  if (course.workflowStatus !== "DRAFT") {
    throw new ApiError(400, "Only draft courses can be deleted");
  }

  await prisma.course.update({
    where: { id: courseId },
    data: { deletedAt: new Date() },
  });
  return { success: true };
}

export async function submitCourseForApproval(userId, courseId, note) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, deletedAt: null },
  });
  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  if (course.educatorId !== userId) {
    throw new ApiError(403, "Forbidden");
  }
  if (course.workflowStatus !== "DRAFT") {
    throw new ApiError(400, "Course is not in draft state");
  }

  return prisma.$transaction(async (tx) => {
    const updatedCourse = await tx.course.update({
      where: { id: courseId },
      data: {
        workflowStatus: "PENDING_APPROVAL",
        isDraftDeletable: false,
        submittedAt: new Date(),
      },
    });

    await tx.courseSubmission.create({
      data: {
        courseId,
        userId,
        note: note || null,
      },
    });

    return updatedCourse;
  });
}

export async function publishCourse(userId, courseId) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, deletedAt: null },
  });

  if (!course) {
    throw new ApiError(404, "Course not found");
  }

  if (course.educatorId !== userId) {
    throw new ApiError(403, "Forbidden");
  }
  if (course.workflowStatus !== "APPROVED") {
    throw new ApiError(400, "Course must be approved before publishing");
  }

  return prisma.course.update({
    where: { id: courseId },
    data: {
      workflowStatus: "PUBLISHED",
      isPublished: true,
    },
  });
}

export async function unpublishCourse(userId, courseId) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, deletedAt: null },
  });

  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  if (course.educatorId !== userId) {
    throw new ApiError(403, "Forbidden");
  }

  return prisma.course.update({
    where: { id: courseId },
    data: {
      workflowStatus: "APPROVED",
      isPublished: false,
    },
  });
}

export async function listCourses(query, user) {
  const { page, limit, skip } = getPagination(query);
  const resolvedLevelId = await resolveLevelId(query.levelId || query.instructional_level);
  const where = {
    deletedAt: null,
    workflowStatus: user?.roles?.includes("ADMIN")
      ? undefined
      : query.includePending === "true" && user?.roles?.includes("EDUCATOR")
        ? undefined
        : "PUBLISHED",
    title: query.search
      ? { contains: query.search, mode: "insensitive" }
      : undefined,
    categoryId: query.categoryId || query.category_id || undefined,
    levelId: resolvedLevelId || undefined,
  };

  const [rows, total] = await Promise.all([
    prisma.course.findMany({
      where,
      skip,
      take: limit,
      include: {
        educator: { select: { id: true, email: true, username: true, firstName: true, lastName: true } },
        category: true,
        level: true,
        priceTier: true,
        sections: {
          include: {
            lessons: {
              select: { id: true, type: true },
            },
          },
        },
        media: {
          where: {
            mediaType: { in: [...COVER_MEDIA_TYPES, ...PROMO_MEDIA_TYPES] },
          },
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.course.count({ where }),
  ]);

  let cartCourseIds = new Set();
  let enrolledCourseIds = new Set();

  if (user?.id) {
    const [cartRows, enrollmentRows] = await Promise.all([
      prisma.cartItem.findMany({
        where: {
          cart: { userId: user.id },
        },
        select: { courseId: true },
      }),
      prisma.enrollment.findMany({
        where: {
          userId: user.id,
          status: "ACTIVE",
        },
        select: { courseId: true },
      }),
    ]);

    cartCourseIds = new Set(cartRows.map((row) => row.courseId));
    enrolledCourseIds = new Set(enrollmentRows.map((row) => row.courseId));
  }

  const mappedRows = rows.map((course) => ({
    ...course,
    is_in_cart: cartCourseIds.has(course.id),
    is_enrolled: enrolledCourseIds.has(course.id),
  }));

  return toPagedResult(mappedRows, total, page, limit);
}

export async function getCourseBySlug(slug) {
  const course = await prisma.course.findFirst({
    where: {
      OR: [{ slug }, { id: slug }],
      deletedAt: null,
    },
    include: {
      educator: { select: { id: true, username: true } },
      category: true,
      level: true,
      priceTier: true,
      media: {
        where: {
          mediaType: { in: [...COVER_MEDIA_TYPES, ...PROMO_MEDIA_TYPES] },
        },
        orderBy: { createdAt: "desc" },
      },
      sections: {
        orderBy: { position: "asc" },
        include: {
          lessons: {
            orderBy: { position: "asc" },
            include: {
              media: {
                orderBy: { createdAt: "desc" },
                take: 1,
              },
            },
          },
        },
      },
      reviews: {
        select: { rating: true },
      },
    },
  });

  if (!course) {
    throw new ApiError(404, "Course not found");
  }

  const avgRating = course.reviews.length
    ? course.reviews.reduce((acc, review) => acc + review.rating, 0) /
      course.reviews.length
    : 0;

  const goals = await readCourseGoals(course.id);

  return mapCourseDetails(course, goals);
}

function mapCourseDetails(course, goals) {
  const avgRating = course.reviews.length
    ? course.reviews.reduce((acc, review) => acc + review.rating, 0) /
      course.reviews.length
    : 0;

  return {
    ...course,
    uuid: course.id,
    cover_image: mapLegacyMedia(
      pickLatestMediaByTypes(course.media, COVER_MEDIA_TYPES),
    ),
    promo_video: mapLegacyMedia(
      pickLatestMediaByTypes(course.media, PROMO_MEDIA_TYPES),
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
    category_ids: course.category ? [{ category_id: course.category.id }] : [],
    goals,
    averageRating: Number(avgRating.toFixed(2)),
    reviewsCount: course.reviews.length,
  };
}

export async function getCourseForManagement(user, slug) {
  const course = await prisma.course.findFirst({
    where: {
      OR: [{ slug }, { id: slug }],
      deletedAt: null,
    },
    include: {
      educator: { select: { id: true, username: true } },
      category: true,
      level: true,
      priceTier: true,
      media: {
        where: {
          mediaType: { in: [...COVER_MEDIA_TYPES, ...PROMO_MEDIA_TYPES] },
        },
        orderBy: { createdAt: "desc" },
      },
      sections: {
        orderBy: { position: "asc" },
        include: {
          lessons: {
            orderBy: { position: "asc" },
            include: {
              media: {
                orderBy: { createdAt: "desc" },
                take: 1,
              },
            },
          },
        },
      },
      reviews: {
        select: { rating: true },
      },
    },
  });

  if (!course) {
    throw new ApiError(404, "Course not found");
  }

  const isOwner = course.educatorId === user?.id;
  const isAdmin = Array.isArray(user?.roles) && user.roles.includes("ADMIN");
  if (!isOwner && !isAdmin) {
    throw new ApiError(403, "Forbidden");
  }

  const goals = await readCourseGoals(course.id);
  return mapCourseDetails(course, goals);
}

export async function getCourseStudentsForManagement(user, slug, query = {}) {
  const course = await prisma.course.findFirst({
    where: {
      OR: [{ slug }, { id: slug }],
      deletedAt: null,
    },
    select: {
      id: true,
      slug: true,
      educatorId: true,
    },
  });

  if (!course) {
    throw new ApiError(404, "Course not found");
  }

  const isOwner = course.educatorId === user?.id;
  const isAdmin = Array.isArray(user?.roles) && user.roles.includes("ADMIN");
  if (!isOwner && !isAdmin) {
    throw new ApiError(403, "Forbidden");
  }

  const { page, limit, skip } = getPagination(query);
  const search = String(query.search || query.q || "")
    .trim()
    .slice(0, 120);

  const activeEnrollmentWhere = {
    courseId: course.id,
    status: { in: ["ACTIVE", "COMPLETED"] },
  };

  const searchUserFilter = search
    ? {
        OR: [
          { firstName: { contains: search, mode: "insensitive" } },
          { lastName: { contains: search, mode: "insensitive" } },
          { username: { contains: search, mode: "insensitive" } },
        ],
      }
    : undefined;

  const listWhere = {
    ...activeEnrollmentWhere,
    user: searchUserFilter,
  };

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [totalStudents, increaseThisMonth, allProgressRows, rows, total] =
    await Promise.all([
      prisma.enrollment.count({ where: activeEnrollmentWhere }),
      prisma.enrollment.count({
        where: {
          ...activeEnrollmentWhere,
          enrolledAt: { gte: startOfMonth },
        },
      }),
      prisma.enrollment.findMany({
        where: activeEnrollmentWhere,
        select: {
          courseProgress: {
            select: { progressPct: true },
          },
        },
      }),
      prisma.enrollment.findMany({
        where: listWhere,
        skip,
        take: limit,
        orderBy: { enrolledAt: "desc" },
        select: {
          id: true,
          status: true,
          enrolledAt: true,
          completedAt: true,
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              username: true,
            },
          },
          courseProgress: {
            select: {
              progressPct: true,
              completedLessons: true,
              totalLessons: true,
              completedAt: true,
            },
          },
        },
      }),
      prisma.enrollment.count({ where: listWhere }),
    ]);

  const averageProgressPct = totalStudents
    ? Number(
        (
          allProgressRows.reduce(
            (sum, row) => sum + Number(row.courseProgress?.progressPct || 0),
            0,
          ) / totalStudents
        ).toFixed(2),
      )
    : 0;

  const mappedRows = rows.map((row) => {
    const progressPct = Number(row.courseProgress?.progressPct || 0);
    const firstName = row.user?.firstName || "";
    const lastName = row.user?.lastName || "";
    const fullName = `${firstName} ${lastName}`.trim();

    return {
      enrollment_id: row.id,
      student: {
        id: row.user?.id || null,
        name: fullName || row.user?.username || "Unknown",
        username: row.user?.username || "",
      },
      enrollment_date: row.enrolledAt,
      status: row.status,
      progress: {
        progress_pct: progressPct,
        completed_lessons: row.courseProgress?.completedLessons || 0,
        total_lessons: row.courseProgress?.totalLessons || 0,
        completed:
          progressPct >= 100 ||
          row.status === "COMPLETED" ||
          Boolean(row.completedAt || row.courseProgress?.completedAt),
      },
    };
  });

  return {
    stats: {
      total_students: totalStudents,
      increase_this_month: increaseThisMonth,
      average_progress_pct: averageProgressPct,
    },
    ...toPagedResult(mappedRows, total, page, limit),
  };
}

export async function listAuthoredCourses(userId, query) {
  const { page, limit, skip } = getPagination(query);
  const resolvedLevelId = await resolveLevelId(query.instructional_level || query.levelId);
  const where = {
    educatorId: userId,
    deletedAt: null,
    title: query.title ? { contains: query.title, mode: "insensitive" } : undefined,
    levelId: resolvedLevelId || undefined,
  };

  const [rows, total] = await Promise.all([
    prisma.course.findMany({
      where,
      skip,
      take: limit,
      include: getCourseInclude(),
      orderBy: { createdAt: "desc" },
    }),
    prisma.course.count({ where }),
  ]);

  return toPagedResult(rows, total, page, limit);
}

export async function getCourseRoute(slug, userId) {
  const course = await prisma.course.findFirst({
    where: {
      slug,
      deletedAt: null,
      workflowStatus: "PUBLISHED",
    },
    include: {
      educator: { select: { id: true, username: true, firstName: true, lastName: true } },
      category: true,
      level: true,
      priceTier: true,
      media: {
        where: {
          mediaType: { in: [...COVER_MEDIA_TYPES, ...PROMO_MEDIA_TYPES] },
        },
        orderBy: { createdAt: "desc" },
      },
      sections: {
        orderBy: { position: "asc" },
        include: {
          lessons: { orderBy: { position: "asc" } },
        },
      },
      reviews: {
        select: { rating: true },
      },
    },
  });

  if (!course) {
    throw new ApiError(404, "Course not found");
  }

  const [isEnrolled, isInCart, isInWishlist] = userId
    ? await Promise.all([
        prisma.enrollment.findFirst({ where: { userId, courseId: course.id } }),
        prisma.cartItem.findFirst({
          where: {
            courseId: course.id,
            cart: { userId },
          },
        }),
        prisma.wishlist.findFirst({
          where: {
            userId,
            courseId: course.id,
          },
        }),
      ])
    : [null, null, null];

  const goals = await readCourseGoals(course.id);
  const coverImage = mapLegacyMedia(
    pickLatestMediaByTypes(course.media, COVER_MEDIA_TYPES),
  );
  const promoVideo = mapLegacyMedia(
    pickLatestMediaByTypes(course.media, PROMO_MEDIA_TYPES),
  );

  return {
    id: course.id,
    slug: course.slug,
    title: course.title,
    subtitle: course.subtitle,
    description: course.description,
    categories: course.category
      ? [{ id: course.category.id, slug: course.category.slug, title: course.category.name || course.category.title }]
      : [],
    sections: course.sections.map((section) => ({
      id: section.id,
      title: section.title,
      curriculums: section.lessons.map((lesson) => ({
        id: lesson.id,
        uuid: lesson.id,
        title: lesson.title,
        curriculum_resource_type: lesson.type.toLowerCase(),
        estimated_duration: lesson.durationInSeconds || 0,
        curriculum_description: lesson.description || "",
      })),
    })),
    resources_count: {
      section_count: course.sections.length,
      curriculum_count: course.sections.reduce((acc, section) => acc + section.lessons.length, 0),
      article_count: course.sections.reduce(
        (acc, section) => acc + section.lessons.filter((lesson) => lesson.type === "RESOURCE").length,
        0,
      ),
    },
    author: {
      data: {
        id: course.educator.id,
        username: course.educator.username,
        firstname: course.educator.firstName || "",
        lastname: course.educator.lastName || "",
        user_picture: null,
      },
    },
    instructional_level: course.level
      ? {
          id: course.level.id,
          title: course.level.title,
        }
      : { id: null, title: "All Levels" },
    price_tier: course.priceTier
      ? {
          id: course.priceTier.id,
          title: course.priceTier.title,
          price: String(course.priceTier.price),
        }
      : null,
    promo_video: promoVideo,
    cover_image: coverImage,
    goals,
    is_enrolled: Boolean(isEnrolled),
    is_in_cart: Boolean(isInCart),
    is_in_wishlist: Boolean(isInWishlist),
  };
}

export async function getCourseForLearner(userId, slug) {
  const enrollment = await prisma.enrollment.findFirst({
    where: {
      userId,
      status: "ACTIVE",
      course: {
        OR: [{ slug }, { id: slug }],
        deletedAt: null,
      },
    },
    include: {
      course: {
        include: {
          sections: {
            orderBy: { position: "asc" },
            include: {
              lessons: {
                orderBy: { position: "asc" },
                include: {
                  media: {
                    where: { mediaType: "VIDEO" },
                    orderBy: { createdAt: "desc" },
                    take: 1,
                  },
                  progress: {
                    where: { userId },
                    orderBy: { updatedAt: "desc" },
                    select: {
                      isCompleted: true,
                      progressPct: true,
                    },
                    take: 1,
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!enrollment) {
    throw new ApiError(404, "Enrollment not found");
  }

  const goals = await readCourseGoals(enrollment.course.id);

  return {
    course: {
      id: enrollment.course.id,
      uuid: enrollment.course.id,
      slug: enrollment.course.slug,
      title: enrollment.course.title,
      subtitle: enrollment.course.subtitle,
      description: enrollment.course.description,
      goals,
      sections: enrollment.course.sections.map((section) => ({
        id: section.id,
        uuid: section.id,
        title: section.title,
        curriculums: section.lessons.map((lesson) => {
          const lessonProgress = lesson.progress?.[0] || null;
          const isTaken = Boolean(lessonProgress?.isCompleted);
          const parsedQuizQuestions = safeParseJson(lesson.quizQuestions);
          const parsedStarterCode = safeParseJson(lesson.codingStarterCode);

          return {
            id: lesson.id,
            uuid: lesson.id,
            title: lesson.title,
            curriculum_resource_type:
                lesson.type === "QUIZ"
                  ? "quiz"
                  : lesson.type === "CODING_EXERCISE"
                    ? "coding_exercise"
                    : lesson.videoUrl || lesson.type === "VIDEO"
                ? "video"
                : lesson.assignmentText
                  ? "article"
                  : "null",
            curriculum_description: lesson.description || "",
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
                        parsedStarterCode?.starter_code || parsedStarterCode || {},
                      expected_output: parsedStarterCode?.expected_output || {},
                      languages: parsedStarterCode?.languages || [],
                    }
                : lesson.videoUrl || lesson.media?.[0]
                ? {
                    id: lesson.media?.[0]?.id || lesson.id,
                    path: lesson.videoUrl || lesson.media?.[0]?.storagePath || null,
                  }
                : lesson.assignmentText
                  ? { id: lesson.id, content: lesson.assignmentText }
                  : null,
            is_taken: isTaken,
            completed: isTaken,
            progress_pct: Number(lessonProgress?.progressPct || 0),
          };
        }),
      })),
    },
  };
}

export async function updateCoursePricing(userId, courseId, priceTierId) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, educatorId: userId, deletedAt: null },
  });
  if (!course) {
    throw new ApiError(404, "Course not found");
  }

  return prisma.course.update({
    where: { id: courseId },
    data: { priceTierId: priceTierId || null },
    include: { priceTier: true },
  });
}
