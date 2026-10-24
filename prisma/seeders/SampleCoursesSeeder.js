import axios from "axios";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { env } from "../../src/shared/config/env.js";
import {
  buildUploadsObjectKey,
  isR2Enabled,
  uploadBufferToR2,
} from "../../src/shared/storage/r2.js";
import { attachAICoverImage } from "../../src/modules/course/course-cover-image.service.js";
import {
  buildAIArticleContent,
  buildFallbackArticle,
} from "../../src/modules/course/course-article.service.js";
import { buildAICodingExercise } from "../../src/modules/course/course-coding-exercise.service.js";
import { generateCourseCertificate } from "../../src/modules/certification/certification.service.js";

const prisma = new PrismaClient();

const TOTAL_COURSES = Number(process.env.SEED_COURSE_COUNT || 50);
const GROUP_CONCURRENCY = 3;
const LESSONS_PER_COURSE = 5;
const SEED_EMAIL_SUFFIX = "@seed.upskill.local";
const MARKER_PREFIX = "seed_course::";
const GOALS_PREFIX = "course_goals::";

// Only these root categories get hands-on coding exercises.
const CODING_ROOT_SLUGS = new Set(["development"]);

const PRICE_TIERS_BY_LEVEL = {
  Beginner: ["Tier 1", "Tier 2", "Tier 3"],
  Intermediate: ["Tier 3", "Tier 4", "Tier 5"],
  Advanced: ["Tier 5", "Tier 6", "Tier 7"],
};

function hashSeed(text) {
  return crypto.createHash("sha256").update(text).digest().readUInt32LE(0);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (list, rand) => list[Math.floor(rand() * list.length)];
const randInt = (min, max, rand) => min + Math.floor(rand() * (max - min + 1));

function shuffle(items, rand) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const clip = (value, max) => String(value || "").trim().slice(0, max);

function readJson(content) {
  const raw = String(content || "").trim();
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

async function withRetry(label, task, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await task();
      if (result) return result;
      lastError = new Error("empty result");
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${label} failed: ${lastError?.message || "unknown error"}`);
}

async function requestCoursePlan({
  rootName,
  subName,
  level,
  educator,
  allowCoding,
  usedTitles,
}) {
  const system =
    "You are an expert instructional designer planning a complete online course. " +
    "Return ONLY a valid JSON object, no markdown. Be specific and realistic; never use placeholders. " +
    `Schema: {"title":"string<=60","subtitle":"string<=150","description":"3 short paragraphs separated by blank lines, <=1800 chars",` +
    `"welcome_message":"string<=400","congratulations_message":"string<=400",` +
    `"what_you_will_learn":["5-6 outcomes"],"requirements":["3-4 items"],"who_should_attend":["3-4 items"],` +
    `"section":{"title":"string<=100","description":"string<=300"},` +
    `"lessons":[{"title":"string<=100","description":"2-3 sentence outline of what the lecture covers","type":"ARTICLE|CODING_EXERCISE","estimated_minutes":number 6-20}],` +
    `"cover_queries":["2-3 short image search phrases describing the course topic visually, no text or logos"]}. ` +
    `The course has exactly ONE section and exactly ${LESSONS_PER_COURSE} lessons that build progressively from fundamentals to application. ` +
    (allowCoding
      ? "Use CODING_EXERCISE for 1-2 lessons where learners practice writing code; all other lessons are ARTICLE. "
      : "Every lesson must be of type ARTICLE (no coding exercises). ") +
    "The title must be unique, catchy and clearly describe the outcome.";

  const user =
    `Category: ${rootName} > ${subName}\n` +
    `Level: ${level}\n` +
    `Instructor: ${educator.name}${educator.headline ? ` (${educator.headline})` : ""}\n` +
    `Language: English\n` +
    (usedTitles.length
      ? `Do NOT reuse or closely resemble these existing titles: ${usedTitles.join(" | ")}\n`
      : "") +
    `Plan a course focused on a distinct, practical topic within "${subName}".`;

  const response = await axios.post(
    `${env.deepseekBaseUrl.replace(/\/+$/g, "")}/chat/completions`,
    {
      model: env.deepseekModel,
      temperature: 0.8,
      max_tokens: 3500,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${env.aiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 120000,
    },
  );
  return readJson(response?.data?.choices?.[0]?.message?.content);
}

function normalizePlan(raw, { allowCoding }) {
  if (!raw || typeof raw !== "object") return null;
  const list = (value, max) =>
    (Array.isArray(value) ? value : [])
      .map((item) => clip(item, 200))
      .filter(Boolean)
      .slice(0, max);

  const lessons = (Array.isArray(raw.lessons) ? raw.lessons : [])
    .slice(0, LESSONS_PER_COURSE)
    .map((lesson) => ({
      title: clip(lesson?.title, 120),
      description: clip(lesson?.description, 600),
      type:
        allowCoding && String(lesson?.type).toUpperCase() === "CODING_EXERCISE"
          ? "CODING_EXERCISE"
          : "ARTICLE",
      minutes: Math.min(20, Math.max(6, Number(lesson?.estimated_minutes) || 10)),
    }));

  const title = clip(raw.title, 60);
  if (!title || lessons.length !== LESSONS_PER_COURSE || lessons.some((l) => !l.title)) {
    return null;
  }

  const lessonTitles = new Set(lessons.map((l) => l.title.toLowerCase()));
  if (lessonTitles.size !== lessons.length) return null;

  return {
    title,
    subtitle: clip(raw.subtitle, 180),
    description: clip(raw.description, 8000),
    welcomeMessage: clip(raw.welcome_message, 5000),
    congratulationsMessage: clip(raw.congratulations_message, 5000),
    goals: {
      what_you_will_learn_data: list(raw.what_you_will_learn, 8),
      requirements_data: list(raw.requirements, 6),
      who_should_attend_data: list(raw.who_should_attend, 6),
    },
    section: {
      title: clip(raw.section?.title, 160) || "Core Concepts",
      description: clip(raw.section?.description, 1000),
    },
    lessons,
    coverQueries: list(raw.cover_queries, 3),
  };
}

async function buildLessonContent(plan, lesson, courseSlugContext) {
  if (lesson.type === "CODING_EXERCISE") {
    const exercise = await buildAICodingExercise({
      courseTitle: plan.title,
      courseDescription: plan.description,
      sectionTitle: plan.section.title,
      lessonTitle: lesson.title,
      lessonDescription: lesson.description,
    });
    return {
      type: "CODING_EXERCISE",
      codingInstructions:
        clip(exercise.instructions, 5000) ||
        clip(lesson.description, 5000) ||
        `Implement the objective of "${lesson.title}".`,
      codingStarterCode: JSON.stringify(exercise.asset),
    };
  }

  let article = null;
  for (let attempt = 0; attempt < 2 && !article; attempt += 1) {
    article = await buildAIArticleContent({
      courseTitle: plan.title,
      courseDescription: plan.description,
      sectionTitle: plan.section.title,
      lessonTitle: lesson.title,
      lessonDescription: lesson.description,
      language: courseSlugContext.language,
    });
  }
  article =
    article ||
    buildFallbackArticle({
      lessonTitle: lesson.title,
      lessonDescription: lesson.description,
    });
  return { type: "RESOURCE", assignmentText: article };
}

// Free stock photo fallback when no openly licensed image could be found by search.
async function attachFallbackCover({ userId, courseId, slug }) {
  const response = await axios.get(`https://picsum.photos/seed/${slug}/1280/720.jpg`, {
    responseType: "arraybuffer",
    timeout: 20000,
    maxRedirects: 5,
  });
  const buffer = Buffer.from(response.data);
  if (!buffer.length) return null;

  let storagePath = null;
  if (isR2Enabled()) {
    const uploaded = await uploadBufferToR2({
      buffer,
      objectKey: buildUploadsObjectKey(`covers/seed/${slug}.jpg`),
      contentType: "image/jpeg",
    });
    storagePath = uploaded.url;
  }
  if (!storagePath) return null;

  return prisma.media.create({
    data: {
      userId,
      courseId,
      storagePath,
      originalName: `${slug}.jpg`,
      mimeType: "image/jpeg",
      mediaType: "COVER_IMAGE",
      sizeInBytes: buffer.length,
    },
  });
}

async function ensureCover({ userId, courseId, slug, queries }) {
  const attached = await attachAICoverImage({ userId, courseId, queries });
  if (attached) return true;
  try {
    return Boolean(await attachFallbackCover({ userId, courseId, slug }));
  } catch (_error) {
    return false;
  }
}

async function uniqueSlug(title) {
  const base = slugify(title) || "course";
  let slug = base;
  let counter = 2;
  while (await prisma.course.findUnique({ where: { slug }, select: { id: true } })) {
    slug = `${base}-${counter}`;
    counter += 1;
  }
  return slug;
}

async function createEnrollments({ course, lessons, learners, rand }) {
  const count = randInt(8, Math.min(25, learners.length), rand);
  const chosen = shuffle(learners, rand).slice(0, count);
  const stats = { enrolled: 0, completed: 0, certificates: 0 };
  const day = 24 * 60 * 60 * 1000;

  for (const learner of chosen) {
    const enrolledAt = new Date(Date.now() - randInt(3, 120, rand) * day);
    const roll = rand();
    // 35% finished, 45% partway, 20% not started.
    const completedCount =
      roll < 0.35 ? lessons.length : roll < 0.8 ? randInt(1, lessons.length - 1, rand) : 0;
    const isFinished = completedCount === lessons.length;
    const lastActivity = new Date(
      Math.min(Date.now() - 60 * 1000, enrolledAt.getTime() + randInt(1, 30, rand) * day),
    );

    const enrollment = await prisma.enrollment.create({
      data: {
        userId: learner.id,
        courseId: course.id,
        status: isFinished ? "COMPLETED" : "ACTIVE",
        accessSource: "PURCHASE",
        enrolledAt,
        completedAt: isFinished ? lastActivity : null,
      },
    });
    stats.enrolled += 1;

    const progressPct = (completedCount / lessons.length) * 100;
    await prisma.courseProgress.create({
      data: {
        enrollmentId: enrollment.id,
        courseId: course.id,
        userId: learner.id,
        progressPct,
        completedLessons: completedCount,
        totalLessons: lessons.length,
        completedAt: isFinished ? lastActivity : null,
      },
    });

    const rows = [];
    lessons.forEach((lesson, index) => {
      if (index < completedCount) {
        rows.push({
          enrollmentId: enrollment.id,
          lessonId: lesson.id,
          userId: learner.id,
          isCompleted: true,
          progressPct: 100,
          lastPosition: lesson.durationInSeconds,
          completedAt: new Date(
            enrolledAt.getTime() +
              ((lastActivity.getTime() - enrolledAt.getTime()) * (index + 1)) /
                lessons.length,
          ),
        });
      } else if (index === completedCount && completedCount > 0 && !isFinished) {
        const partial = randInt(10, 80, rand);
        rows.push({
          enrollmentId: enrollment.id,
          lessonId: lesson.id,
          userId: learner.id,
          isCompleted: false,
          progressPct: partial,
          lastPosition: Math.floor((lesson.durationInSeconds * partial) / 100),
        });
      }
    });
    if (rows.length) await prisma.lessonProgress.createMany({ data: rows });

    if (isFinished) {
      stats.completed += 1;
      try {
        await generateCourseCertificate(learner.id, course.slug);
        stats.certificates += 1;
      } catch (error) {
        console.log(`   ⚠️ Certificate failed for ${learner.id}: ${error.message}`);
      }
    }
  }
  return stats;
}

async function seedOneCourse({ slot, context }) {
  const rand = mulberry32(hashSeed(slot.key));
  const { educators, learners, levels, tiers, admin, usedTitles } = context;

  const educatorUser = pick(educators, rand);
  const level = pick(
    [
      ...Array(9).fill("Beginner"),
      ...Array(7).fill("Intermediate"),
      ...Array(4).fill("Advanced"),
    ],
    rand,
  );
  const subCategory = slot.subCategory;
  const allowCoding =
    CODING_ROOT_SLUGS.has(slot.root.slug) ||
    (slot.root.slug === "it-software" &&
      /python|script|sql|bash|programming|code/i.test(subCategory.name));

  const educatorName =
    `${educatorUser.firstName || ""} ${educatorUser.lastName || ""}`.trim() ||
    educatorUser.username;

  const plan = await withRetry(`plan for ${slot.key}`, async () => {
    const raw = await requestCoursePlan({
      rootName: slot.root.name,
      subName: subCategory.name,
      level,
      educator: { name: educatorName, headline: educatorUser.headline },
      allowCoding,
      usedTitles: [...usedTitles].slice(-40),
    });
    const normalized = normalizePlan(raw, { allowCoding });
    if (!normalized) return null;
    if (usedTitles.has(normalized.title.toLowerCase())) return null;
    const dup = await prisma.course.findFirst({
      where: { title: { equals: normalized.title, mode: "insensitive" }, deletedAt: null },
      select: { id: true },
    });
    return dup ? null : normalized;
  });
  usedTitles.add(plan.title.toLowerCase());

  const language = "English";
  const lessonContents = await Promise.all(
    plan.lessons.map((lesson) => buildLessonContent(plan, lesson, { language })),
  );

  const topics = await prisma.topic.findMany({
    where: { categoryId: subCategory.id, deletedAt: null },
    select: { id: true },
  });

  const slug = await uniqueSlug(plan.title);
  const tierTitle = rand() < 0.08 ? "Free" : pick(PRICE_TIERS_BY_LEVEL[level], rand);
  const now = new Date();
  const createdAt = new Date(now.getTime() - randInt(30, 150, rand) * 86400000);

  let course = null;
  try {
    course = await prisma.course.create({
      data: {
        educatorId: educatorUser.id,
        categoryId: subCategory.id,
        levelId: levels.get(level) || null,
        priceTierId: tiers.get(tierTitle) || null,
        title: plan.title,
        subtitle: plan.subtitle || null,
        slug,
        description: plan.description || null,
        welcomeMessage: plan.welcomeMessage || null,
        congratulationsMessage: plan.congratulationsMessage || null,
        language,
        workflowStatus: "PUBLISHED",
        isPublished: true,
        isDraftDeletable: false,
        submittedAt: createdAt,
        approvedAt: createdAt,
        approvedById: admin?.id || null,
        subscriptionEligible: true,
        createdAt,
      },
    });

    await prisma.courseSubmission.create({
      data: {
        courseId: course.id,
        userId: educatorUser.id,
        note: "Auto-submitted by sample course seeder",
        createdAt,
      },
    });

    await prisma.platformSetting.upsert({
      where: { key: `${GOALS_PREFIX}${course.id}` },
      update: { value: JSON.stringify(plan.goals) },
      create: {
        key: `${GOALS_PREFIX}${course.id}`,
        value: JSON.stringify(plan.goals),
        description: `Goals for course ${course.id}`,
      },
    });

    const section = await prisma.courseSection.create({
      data: {
        courseId: course.id,
        title: plan.section.title,
        description: plan.section.description || null,
        position: 1,
      },
    });

    const lessons = [];
    for (let index = 0; index < plan.lessons.length; index += 1) {
      const planned = plan.lessons[index];
      const topic = topics.length ? pick(topics, rand) : null;
      const lesson = await prisma.lesson.create({
        data: {
          sectionId: section.id,
          courseId: course.id,
          topicId: topic?.id || null,
          title: planned.title,
          description: planned.description || null,
          position: index + 1,
          durationInSeconds: planned.minutes * 60,
          isPreview: index === 0,
          ...lessonContents[index],
        },
      });
      if (topic && prisma.lessonTopic) {
        await prisma.lessonTopic.create({
          data: { lessonId: lesson.id, topicId: topic.id },
        });
      }
      lessons.push(lesson);
    }

    const coverOk = await ensureCover({
      userId: educatorUser.id,
      courseId: course.id,
      slug,
      queries: [...plan.coverQueries, subCategory.name, slot.root.name],
    });

    await prisma.platformSetting.create({
      data: {
        key: slot.key,
        value: JSON.stringify({ courseId: course.id }),
        description: "Sample course seeder marker",
      },
    });

    const stats = await createEnrollments({ course, lessons, learners, rand });
    console.log(
      `✅ ${plan.title} [${slot.root.name} > ${subCategory.name}, ${level}, ${tierTitle}] ` +
        `educator=${educatorUser.username} cover=${coverOk ? "yes" : "NO"} ` +
        `enrolled=${stats.enrolled} completed=${stats.completed} certs=${stats.certificates}`,
    );
  } catch (error) {
    if (course) {
      await prisma.course.delete({ where: { id: course.id } }).catch(() => {});
      await prisma.platformSetting
        .deleteMany({ where: { key: { in: [`${GOALS_PREFIX}${course.id}`, slot.key] } } })
        .catch(() => {});
    }
    throw error;
  }
}

async function runPool(groups, worker, concurrency) {
  const queue = [...groups];
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const group = queue.shift();
      await worker(group);
    }
  });
  await Promise.all(runners);
}

export default class SampleCoursesSeeder {
  constructor() {
    // Runs after users, categories, topics, levels and price tiers.
    this.weight = 40;
  }

  async run() {
    if (!env.aiKey) {
      console.log("⚠️ AI_KEY is not configured. Skipping sample courses.");
      return;
    }

    const [educators, learners, admin, levelRows, tierRows, roots] = await Promise.all([
      prisma.user.findMany({
        where: {
          email: { endsWith: SEED_EMAIL_SUFFIX },
          deletedAt: null,
          roles: { some: { role: { name: "EDUCATOR" } } },
        },
        select: { id: true, username: true, firstName: true, lastName: true, headline: true },
        orderBy: { email: "asc" },
      }),
      prisma.user.findMany({
        where: {
          email: { endsWith: SEED_EMAIL_SUFFIX },
          deletedAt: null,
          roles: { some: { role: { name: "LEARNER" } } },
        },
        select: { id: true },
        orderBy: { email: "asc" },
      }),
      prisma.user.findUnique({ where: { email: "admin@upskill.local" }, select: { id: true } }),
      prisma.courseLevel.findMany({ select: { id: true, title: true } }),
      prisma.coursePriceTier.findMany({ select: { id: true, title: true } }),
      prisma.category.findMany({
        where: { parentId: null, deletedAt: null },
        select: { id: true, name: true, slug: true },
        orderBy: { slug: "asc" },
      }),
    ]);

    if (!educators.length || !learners.length) {
      console.log("⚠️ Seeded educators/learners missing. Run SampleUsersSeeder first.");
      return;
    }
    if (!roots.length) {
      console.log("⚠️ No categories found. Run CategorySeeder first.");
      return;
    }
    if (!isR2Enabled()) {
      console.log("⚠️ R2 is not configured; cover images fall back to local uploads.");
    }

    // Spread the courses evenly across every root category.
    const base = Math.floor(TOTAL_COURSES / roots.length);
    const extra = TOTAL_COURSES % roots.length;
    const groups = [];
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
      const root = roots[rootIndex];
      const count = base + (rootIndex < extra ? 1 : 0);
      if (!count) continue;

      const children = await prisma.category.findMany({
        where: { parentId: root.id, deletedAt: null },
        select: { id: true, name: true, slug: true },
        orderBy: { slug: "asc" },
      });
      const pool = children.length ? children : [root];
      const rand = mulberry32(hashSeed(`subs::${root.slug}`));
      const subs = shuffle(pool, rand);
      const slots = Array.from({ length: count }, (_, n) => ({
        key: `${MARKER_PREFIX}${root.slug}::${n + 1}`,
        root,
        subCategory: subs[n % subs.length],
      }));
      groups.push({ root, slots });
    }

    const existingMarkers = new Set(
      (
        await prisma.platformSetting.findMany({
          where: { key: { startsWith: MARKER_PREFIX } },
          select: { key: true },
        })
      ).map((row) => row.key),
    );

    const context = {
      educators,
      learners,
      admin,
      levels: new Map(levelRows.map((row) => [row.title, row.id])),
      tiers: new Map(tierRows.map((row) => [row.title, row.id])),
      usedTitles: new Set(
        (await prisma.course.findMany({ select: { title: true } })).map((c) =>
          c.title.toLowerCase(),
        ),
      ),
    };

    let created = 0;
    let skipped = 0;
    let failed = 0;

    await runPool(
      groups,
      async (group) => {
        // Courses in one category run sequentially so each plan sees the previous titles.
        for (const slot of group.slots) {
          if (existingMarkers.has(slot.key)) {
            skipped += 1;
            continue;
          }
          try {
            await seedOneCourse({ slot, context });
            created += 1;
          } catch (error) {
            failed += 1;
            console.log(`❌ ${slot.key}: ${error.message}`);
          }
        }
      },
      GROUP_CONCURRENCY,
    );

    console.log(
      `✅ Sample courses: ${created} created, ${skipped} already existed, ${failed} failed`,
    );
    if (failed) {
      console.log("   Re-run the seeder to retry the failed courses.");
    }
  }
}
