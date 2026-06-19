import { z } from "zod";
import {
  createCourse,
  deleteDraftCourse,
  getCourseForManagement,
  getCourseStatisticsForManagement,
  getCourseForLearner,
  getCourseRoute,
  getCourseBySlug,
  getCourseStudentsForManagement,
  listAuthoredCourses,
  listCourses,
  publishCourse,
  submitCourseForApproval,
  unpublishCourse,
  updateCoursePricing,
  updateCourseGoals,
  updateCourse,
  updateCourseMessages,
} from "./course.service.js";

const submitSchema = z.object({
  note: z.string().optional(),
});

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

function toLegacyCourseSummary(course) {
  const coverImage = mapLegacyMedia(
    pickLatestMediaByTypes(course.media, ["COVER_IMAGE", "IMAGE"]),
  );
  const promoVideo = mapLegacyMedia(
    pickLatestMediaByTypes(course.media, ["PROMO_VIDEO"]),
  );

  return {
    ...course,
    uuid: course.id,
    cover_image: coverImage,
    promo_video: promoVideo,
    instructional_level: course.level
      ? { id: course.level.id, title: course.level.title }
      : { id: null, title: "All Levels" },
    price_tier: course.priceTier
      ? {
          id: course.priceTier.id,
          title: course.priceTier.title,
          price: String(course.priceTier.price),
        }
      : null,
    author: {
      data: {
        id: course.educator?.id,
        username: course.educator?.username,
        firstname: course.educator?.firstName || course.educator?.firstname || "",
        lastname: course.educator?.lastName || course.educator?.lastname || "",
        user_picture: null,
      },
    },
    resources_count: {
      section_count: course.sections?.length || 0,
      curriculum_count: course.sections?.reduce((acc, section) => acc + (section.lessons?.length || 0), 0) || 0,
      article_count:
        course.sections?.reduce(
          (acc, section) =>
            acc + (section.lessons?.filter((lesson) => lesson.type === "ARTICLE").length || 0),
          0,
        ) || 0,
    },
    is_in_cart: Boolean(course.is_in_cart),
    is_enrolled: Boolean(course.is_enrolled),
    published: course.isPublished ? "1" : "0",
  };
}

export async function createCourseController(req, res) {
  const data = await createCourse(req.user.id, req.body);
  return res.status(201).json({ message: "Course created", data: { ...data, uuid: data.id } });
}

export async function updateCourseController(req, res) {
  const data = await updateCourse(req.user.id, req.params.courseId, req.body);
  return res.json({ message: "Course updated", data: toLegacyCourseSummary(data) });
}

export async function deleteDraftCourseController(req, res) {
  const data = await deleteDraftCourse(req.user.id, req.params.courseId);
  return res.json({ message: "Draft course deleted", data });
}

export async function submitCourseController(req, res) {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Validation failed", details: parsed.error.issues });
  }
  const data = await submitCourseForApproval(req.user.id, req.params.courseId, parsed.data.note);
  return res.json({ message: "Course submitted for approval", data });
}

export async function publishCourseController(req, res) {
  const data = await publishCourse(req.user.id, req.params.courseId);
  return res.json({ message: "Course published", data });
}

export async function unpublishCourseController(req, res) {
  const data = await unpublishCourse(req.user.id, req.params.courseId);
  return res.json({ message: "Course unpublished", data });
}

export async function listCoursesController(req, res) {
  const data = await listCourses(req.query, req.user);
  return res.json({
    message: "Courses fetched",
    ...data,
    data: data.data.map(toLegacyCourseSummary),
  });
}

export async function getCourseBySlugController(req, res) {
  const data = await getCourseBySlug(req.params.slug);
  return res.json({ message: "Course fetched", data });
}

export async function getCourseForManagementController(req, res) {
  const data = await getCourseForManagement(req.user, req.params.slug);
  return res.json({ message: "Course fetched", data });
}

export async function getCourseStudentsForManagementController(req, res) {
  const data = await getCourseStudentsForManagement(
    req.user,
    req.params.slug,
    req.query,
  );

  return res.json({
    message: "Course students fetched",
    data: data.data,
    stats: data.stats,
    pagination: {
      page: data.pagination.page,
      limit: data.pagination.limit,
      total: data.pagination.total,
      total_pages: data.pagination.totalPages,
    },
  });
}

export async function getCourseStatisticsForManagementController(req, res) {
  const data = await getCourseStatisticsForManagement(req.user, req.params.slug);
  return res.json({
    message: "Course statistics fetched",
    data,
  });
}

export async function listAuthoredCoursesController(req, res) {
  const data = await listAuthoredCourses(req.user.id, req.query);
  return res.json({
    message: "Courses fetched",
    data: data.data.map(toLegacyCourseSummary),
    pagination: {
      page: data.pagination.page,
      limit: data.pagination.limit,
      total: data.pagination.total,
      total_pages: data.pagination.totalPages,
    },
  });
}

export async function getCourseRouteController(req, res) {
  const data = await getCourseRoute(req.params.slug, req.user?.id);
  return res.json({ ...data, uuid: data.id });
}

export async function getCourseForLearnerController(req, res) {
  const data = await getCourseForLearner(req.user.id, req.params.slug);
  return res.json({ message: "Course fetched", data });
}

export async function updateCoursePricingController(req, res) {
  const data = await updateCoursePricing(
    req.user.id,
    req.params.courseId,
    req.body.price_tier || req.body.priceTierId,
  );
  return res.json({
    message: "Course pricing updated",
    data: {
      id: data.id,
      uuid: data.id,
      price_tier: data.priceTier
        ? {
            id: data.priceTier.id,
            title: data.priceTier.title,
            price: String(data.priceTier.price),
          }
        : null,
    },
  });
}

export async function updateCourseGoalsController(req, res) {
  const data = await updateCourseGoals(req.user.id, req.params.courseId, req.body);
  return res.json({ message: "Course goals updated", data });
}

export async function updateCourseMessagesController(req, res) {
  const data = await updateCourseMessages(req.user.id, req.params.courseId, req.body);
  return res.json({
    message: "Course messages updated",
    data: {
      id: data.id,
      uuid: data.id,
      welcome_message: data.welcomeMessage || "",
      congratulations_message: data.congratulationsMessage || "",
    },
  });
}
