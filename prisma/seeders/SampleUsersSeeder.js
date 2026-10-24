import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";
import {
  buildUploadsObjectKey,
  isR2Enabled,
  uploadBufferToR2,
} from "../../src/shared/storage/r2.js";

const prisma = new PrismaClient();

const LEARNER_COUNT = 50;
const EDUCATOR_COUNT = 30;
const SEED_PASSWORD = "Password@12345";
const EMAIL_DOMAIN = "seed.upskill.local";
const PICTURE_KEY_PREFIX = "profile_picture::";

const FEMALE_FIRST = [
  "Maria", "Angela", "Sofia", "Isabel", "Camille", "Patricia", "Jasmine", "Katrina",
  "Nicole", "Bianca", "Andrea", "Danica", "Hannah", "Clarisse", "Trisha", "Lorraine",
  "Mikaela", "Gabrielle", "Leanne", "Ysabel", "Carmela", "Dianne", "Erika", "Faith",
  "Gwen", "Jillian", "Kyla", "Liza", "Monica", "Noelle",
];
const MALE_FIRST = [
  "Juan", "Miguel", "Carlo", "Rafael", "Joshua", "Daniel", "Gabriel", "Mark",
  "Paolo", "Jericho", "Francis", "Adrian", "Kenneth", "Lorenzo", "Nathan", "Oliver",
  "Patrick", "Ramon", "Sebastian", "Tristan", "Vincent", "Wesley", "Xavier", "Andre",
  "Bryan", "Cedric", "Dominic", "Elijah", "Felix", "Gerald",
];
const LAST_NAMES = [
  "Santos", "Reyes", "Cruz", "Bautista", "Ocampo", "Garcia", "Mendoza", "Torres",
  "Flores", "Ramos", "Aquino", "Castillo", "Villanueva", "Navarro", "Domingo", "Salazar",
  "Aguilar", "Pascual", "Mercado", "Valdez", "Soriano", "Fernandez", "Lim", "Tan",
  "Dela Cruz", "Manalo", "Padilla", "Rivera", "Guevarra", "Lacson",
];

const LEARNER_INTERESTS = [
  "web development", "data analysis", "UI/UX design", "digital marketing", "machine learning",
  "mobile app development", "cybersecurity", "cloud computing", "photography", "business analytics",
  "project management", "creative writing", "video editing", "financial literacy", "public speaking",
];
const LEARNER_GOALS = [
  "switch careers into tech", "grow my freelance business", "get promoted at work",
  "build my own startup", "finish my degree with stronger skills", "learn something new every month",
  "prepare for certification exams", "upskill while working full time",
];
const LEARNER_HEADLINES = [
  "Lifelong learner", "Aspiring developer", "Career shifter", "Self-taught enthusiast",
  "Student and part-time freelancer", "Curious builder", "Upskilling every day",
];

const EDUCATOR_SUBJECTS = [
  "Full-Stack Web Development", "Data Science", "UI/UX Design", "Digital Marketing",
  "Machine Learning", "Mobile App Development", "Cybersecurity", "Cloud Architecture",
  "Photography", "Business Analytics", "Project Management", "Copywriting",
  "Video Production", "Personal Finance", "Public Speaking",
];
const EDUCATOR_TITLES = [
  "Senior Instructor", "Industry Practitioner", "Lead Mentor", "Certified Trainer",
  "Consultant and Educator", "Former Engineering Manager", "Creative Director and Teacher",
];

// Deterministic PRNG so repeated runs produce the same dataset.
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

function shuffle(items, rand) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function slugify(value) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

// Every (name, surname, gender) combination is unique; portraits are unique per gender
// (randomuser.me serves free, openly usable portraits 0-99 per gender).
function buildPeople(total) {
  const rand = mulberry32(20261025);
  const combos = [];
  for (const first of FEMALE_FIRST) {
    for (const last of LAST_NAMES) combos.push({ first, last, gender: "women" });
  }
  for (const first of MALE_FIRST) {
    for (const last of LAST_NAMES) combos.push({ first, last, gender: "men" });
  }

  const seenNames = new Set();
  const usedPortraits = { women: 0, men: 0 };
  const portraitOrder = {
    women: shuffle([...Array(100).keys()], rand),
    men: shuffle([...Array(100).keys()], rand),
  };

  const people = [];
  for (const combo of shuffle(combos, rand)) {
    if (people.length >= total) break;
    const fullName = `${combo.first} ${combo.last}`;
    if (seenNames.has(fullName)) continue;
    if (usedPortraits[combo.gender] >= 100) continue;
    seenNames.add(fullName);
    const portraitIndex = portraitOrder[combo.gender][usedPortraits[combo.gender]];
    usedPortraits[combo.gender] += 1;
    people.push({
      ...combo,
      photo: `https://randomuser.me/api/portraits/${combo.gender}/${portraitIndex}.jpg`,
    });
  }
  return people;
}

function pick(list, index) {
  return list[index % list.length];
}

function buildLearner(person, index) {
  const handle = `${slugify(person.first)}${slugify(person.last)}`;
  const interestA = pick(LEARNER_INTERESTS, index);
  const interestB = pick(LEARNER_INTERESTS, index * 3 + 5);
  const goal = pick(LEARNER_GOALS, index * 2 + 1);
  return {
    username: `learner.${handle}`,
    email: `learner.${handle}@${EMAIL_DOMAIN}`,
    firstName: person.first,
    lastName: person.last,
    headline: `${pick(LEARNER_HEADLINES, index)} • ${interestA}`,
    biography:
      `Hi, I'm ${person.first}! I'm currently exploring ${interestA} and ${interestB} ` +
      `because I want to ${goal}. I enjoy learning through hands-on projects and ` +
      `sharing notes with fellow learners.`,
    link_github: index % 3 === 0 ? `https://github.com/learner-${handle}` : null,
    link_linkedin: index % 2 === 0 ? `https://www.linkedin.com/in/${handle}` : null,
    photo: person.photo,
    role: "LEARNER",
  };
}

function buildEducator(person, index) {
  const handle = `${slugify(person.first)}${slugify(person.last)}`;
  const subject = pick(EDUCATOR_SUBJECTS, index);
  const secondary = pick(EDUCATOR_SUBJECTS, index + 4);
  const years = 5 + ((index * 7) % 16);
  return {
    username: `educator.${handle}`,
    email: `educator.${handle}@${EMAIL_DOMAIN}`,
    firstName: person.first,
    lastName: person.last,
    headline: `${subject} ${pick(EDUCATOR_TITLES, index)}`,
    biography:
      `I'm ${person.first} ${person.last}, a ${subject} instructor with ${years}+ years ` +
      `of professional experience. I've mentored hundreds of students and teams, and I also ` +
      `work on ${secondary}. My courses focus on practical, project-based lessons ` +
      `so you can apply what you learn right away.`,
    link_website: `https://${handle}.example.com`,
    link_linkedin: `https://www.linkedin.com/in/${handle}`,
    link_github: `https://github.com/edu-${handle}`,
    link_x: `https://x.com/edu_${handle}`,
    link_youtube: index % 2 === 0 ? `https://www.youtube.com/@${handle}` : null,
    photo: person.photo,
    role: "EDUCATOR",
  };
}

async function downloadImage(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

// Uploads the source portrait to Cloudflare R2 (when configured) and returns the final
// public URL plus size. The object key is deterministic, so re-runs overwrite in place.
async function resolvePhoto(sourceUrl, username) {
  if (!isR2Enabled()) return { url: sourceUrl, size: 0 };
  const objectKey = buildUploadsObjectKey(`avatars/seed/${username}.jpg`);
  const buffer = await downloadImage(sourceUrl);
  const uploaded = await uploadBufferToR2({
    buffer,
    objectKey,
    contentType: "image/jpeg",
  });
  return { url: uploaded.url, size: buffer.length };
}

async function setProfilePicture(userId, sourceUrl, username) {
  const { url, size } = await resolvePhoto(sourceUrl, username);
  const data = {
    storagePath: url,
    originalName: `${username}.jpg`,
    mimeType: "image/jpeg",
    mediaType: "IMAGE",
    sizeInBytes: size,
  };

  let media = await prisma.media.findFirst({
    where: { userId, mediaType: "IMAGE" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  media = media
    ? await prisma.media.update({ where: { id: media.id }, data, select: { id: true } })
    : await prisma.media.create({
        data: { userId, ...data },
        select: { id: true },
      });

  const key = `${PICTURE_KEY_PREFIX}${userId}`;
  const value = JSON.stringify({ mediaId: media.id });
  await prisma.platformSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value, description: "Seeded profile picture" },
  });
}

export default class SampleUsersSeeder {
  constructor() {
    this.weight = 20;
  }

  async run() {
    const [learnerRole, educatorRole] = await Promise.all([
      prisma.role.findUnique({ where: { name: "LEARNER" } }),
      prisma.role.findUnique({ where: { name: "EDUCATOR" } }),
    ]);
    if (!learnerRole || !educatorRole) {
      console.log("⚠️ LEARNER/EDUCATOR roles missing. Run RolePermissionSeeder first.");
      return;
    }
    const roleIds = { LEARNER: learnerRole.id, EDUCATOR: educatorRole.id };

    // One pool guarantees no person (name or portrait) is reused across roles.
    const people = buildPeople(LEARNER_COUNT + EDUCATOR_COUNT);
    const learners = people
      .slice(0, LEARNER_COUNT)
      .map((person, index) => buildLearner(person, index));
    const educators = people
      .slice(LEARNER_COUNT)
      .map((person, index) => buildEducator(person, index));
    const accounts = [...learners, ...educators];

    const usernames = new Set(accounts.map((a) => a.username));
    const emails = new Set(accounts.map((a) => a.email));
    if (usernames.size !== accounts.length || emails.size !== accounts.length) {
      throw new Error("Generated sample users are not unique");
    }

    const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);
    let created = 0;
    let skipped = 0;

    for (const account of accounts) {
      const { role, photo, ...data } = account;

      // Never overwrite an existing account's data; only (re)sync its profile picture.
      const existing = await prisma.user.findFirst({
        where: { OR: [{ email: data.email }, { username: data.username }] },
        select: { id: true, username: true },
      });
      if (existing) {
        await setProfilePicture(existing.id, photo, existing.username);
        skipped += 1;
        continue;
      }

      const user = await prisma.user.create({
        data: {
          ...data,
          passwordHash,
          isActive: true,
          emailVerifiedAt: new Date(),
        },
      });
      await prisma.userRole.create({
        data: { userId: user.id, roleId: roleIds[role] },
      });
      await setProfilePicture(user.id, photo, data.username);
      created += 1;
    }

    console.log(
      `✅ Sample users: ${created} created, ${skipped} already existed ` +
        `(${LEARNER_COUNT} learners, ${EDUCATOR_COUNT} educators; password: ${SEED_PASSWORD})`,
    );
  }
}
