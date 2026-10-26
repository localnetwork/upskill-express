import { PrismaClient } from "@prisma/client";
import axios from "axios";
import { env } from "../../src/shared/config/env.js";

const prisma = new PrismaClient();

const COURSE_SLUG =
  process.env.REVIEW_SEED_COURSE_SLUG || "html-css-and-javascript-fundamentals";
const TARGET_REVIEWS = Math.max(
  15,
  Number(process.env.REVIEW_SEED_COUNT || 20) || 20,
);
const SEED_EMAIL_DOMAIN = "@seed.upskill.local";

// Skewed toward positive ratings, like real course reviews.
const RATING_WEIGHTS = [
  [5, 52],
  [4, 28],
  [3, 11],
  [2, 5],
  [1, 4],
];

const FALLBACK_REVIEWS = {
  5: [
    ["Perfect for beginners", "Clear explanations and hands-on exercises. I built my first responsive page by the end of the first section."],
    ["Exactly what I needed", "The JavaScript section finally made the DOM click for me. Great pacing and practical examples."],
    ["Highly recommended", "Well structured from HTML basics to JavaScript fundamentals. The instructor explains every concept patiently."],
    ["Worth every minute", "I had tried other tutorials before, but this course connected HTML, CSS and JavaScript in a way that made sense."],
  ],
  4: [
    ["Solid fundamentals", "Great overview of the core web technologies. I would have liked a few more advanced projects, but overall very good."],
    ["Good course", "Easy to follow and well organized. The CSS layout lessons were the highlight for me."],
    ["Very helpful", "Covers the essentials nicely. Some videos could be a bit shorter, but the content is accurate and useful."],
  ],
  3: [
    ["Decent but basic", "Good for absolute beginners, though if you already know some HTML you may find the first sections slow."],
    ["Okay overall", "The content is fine, but I wanted more practice exercises in the JavaScript part."],
  ],
  2: [
    ["Needs more depth", "Some topics felt rushed, especially functions and events. I had to look elsewhere to fully understand them."],
  ],
  1: [
    ["Not what I expected", "Too introductory for my level and the examples felt outdated in a few places."],
  ],
};

function pickRating() {
  const total = RATING_WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = Math.random() * total;
  for (const [rating, weight] of RATING_WEIGHTS) {
    roll -= weight;
    if (roll <= 0) return rating;
  }
  return 5;
}

function randomPastDate(maxDaysAgo) {
  const daysAgo = Math.random() * maxDaysAgo;
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
}

function parseJsonArray(content) {
  const text = String(content || "")
    .replace(/```json|```/gi, "")
    .trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

async function generateReviewsWithAI(course, ratings) {
  if (!env.aiKey) {
    console.log("⚠️ AI_KEY not configured; using fallback review text.");
    return null;
  }

  const prompt =
    `Course: "${course.title}"${course.subtitle ? ` — ${course.subtitle}` : ""}\n` +
    `Write ${ratings.length} distinct, realistic learner reviews for this course, one per rating in this exact order: ${JSON.stringify(ratings)}.\n` +
    "Rules: the tone must match the star rating (5 = enthusiastic, 3 = mixed, 1-2 = constructive criticism). " +
    "Vary length (1-4 sentences), voice and focus (HTML, CSS, JavaScript, pacing, projects, instructor). " +
    "Mention specific course topics sometimes. No emojis, no hashtags, no names. Never repeat phrasing between reviews. " +
    'Return only a JSON array of objects: [{"title": string (max 60 chars), "comment": string}] with the same length and order as the ratings.';

  try {
    const response = await axios.post(
      `${env.deepseekBaseUrl.replace(/\/+$/g, "")}/chat/completions`,
      {
        model: env.deepseekModel,
        temperature: 1.1,
        messages: [
          {
            role: "system",
            content:
              "You write authentic online course reviews. Return only valid JSON with no markdown fences.",
          },
          { role: "user", content: prompt },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${env.aiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 90000,
      },
    );
    const parsed = parseJsonArray(response?.data?.choices?.[0]?.message?.content);
    if (!parsed || parsed.length < ratings.length) {
      console.log("⚠️ AI returned an unusable response; using fallback review text.");
      return null;
    }
    return parsed.map((item) => ({
      title: String(item?.title || "").trim().slice(0, 120),
      comment: String(item?.comment || "").trim(),
    }));
  } catch (error) {
    console.log(`⚠️ AI request failed (${error?.message}); using fallback review text.`);
    return null;
  }
}

function fallbackReview(rating, index) {
  const pool = FALLBACK_REVIEWS[rating] || FALLBACK_REVIEWS[5];
  const [title, comment] = pool[index % pool.length];
  return { title, comment };
}

export default class ReviewSeeder {
  constructor() {
    this.weight = 50;
  }

  async run() {
    const course = await prisma.course.findFirst({
      where: { slug: COURSE_SLUG, deletedAt: null },
      select: { id: true, title: true, subtitle: true, educatorId: true },
    });
    if (!course) {
      console.log(`⚠️ Course "${COURSE_SLUG}" not found. Skipping review seeding.`);
      return;
    }

    const existingCount = await prisma.review.count({ where: { courseId: course.id } });
    const needed = TARGET_REVIEWS - existingCount;
    if (needed <= 0) {
      console.log(`✅ Reviews: "${COURSE_SLUG}" already has ${existingCount} reviews.`);
      return;
    }

    const reviewedUserIds = (
      await prisma.review.findMany({
        where: { courseId: course.id },
        select: { userId: true },
      })
    ).map((row) => row.userId);

    const learnerFilter = {
      deletedAt: null,
      isActive: true,
      id: { notIn: [course.educatorId, ...reviewedUserIds] },
      roles: { some: { role: { name: "LEARNER" } } },
    };
    // Real learners come first; placeholder seed accounts only fill the remainder.
    const realLearners = await prisma.user.findMany({
      where: { ...learnerFilter, NOT: { email: { endsWith: SEED_EMAIL_DOMAIN } } },
      select: { id: true },
      take: 500,
    });
    const shuffledReal = [...realLearners].sort(() => Math.random() - 0.5).slice(0, needed);
    let shuffled = shuffledReal;
    if (shuffledReal.length < needed) {
      const seedLearners = await prisma.user.findMany({
        where: { ...learnerFilter, email: { endsWith: SEED_EMAIL_DOMAIN } },
        select: { id: true },
        take: 500,
      });
      const fill = [...seedLearners]
        .sort(() => Math.random() - 0.5)
        .slice(0, needed - shuffledReal.length);
      shuffled = [...shuffledReal, ...fill];
    }
    if (shuffled.length === 0) {
      console.log("⚠️ No eligible learners found.");
      return;
    }
    if (shuffled.length < needed) {
      console.log(`⚠️ Only ${shuffled.length} eligible learners available (wanted ${needed}).`);
    }

    const ratings = shuffled.map(() => pickRating());
    const aiTexts = await generateReviewsWithAI(course, ratings);

    let created = 0;
    for (let index = 0; index < shuffled.length; index += 1) {
      const userId = shuffled[index].id;
      const rating = ratings[index];
      const text =
        aiTexts?.[index]?.comment ? aiTexts[index] : fallbackReview(rating, index);

      const reviewedAt = randomPastDate(365);
      const enrolledAt = new Date(
        reviewedAt.getTime() - (7 + Math.random() * 60) * 24 * 60 * 60 * 1000,
      );

      const enrollment = await prisma.enrollment.upsert({
        where: { userId_courseId: { userId, courseId: course.id } },
        update: {},
        create: {
          userId,
          courseId: course.id,
          status: "COMPLETED",
          accessSource: "PURCHASE",
          enrolledAt,
          completedAt: reviewedAt,
        },
        select: { id: true, review: { select: { id: true } } },
      });
      if (enrollment.review) continue;

      await prisma.review.create({
        data: {
          userId,
          courseId: course.id,
          enrollmentId: enrollment.id,
          rating,
          title: text.title || null,
          comment: text.comment,
          createdAt: reviewedAt,
          updatedAt: reviewedAt,
        },
      });
      created += 1;
    }

    console.log(
      `✅ Reviews: ${created} created for "${COURSE_SLUG}" ` +
        `(${aiTexts ? "AI-generated" : "template"} text, total now ${existingCount + created})`,
    );
  }
}
