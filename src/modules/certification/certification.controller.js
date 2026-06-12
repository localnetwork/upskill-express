import {
  generateCourseCertificate,
  getCertificateBySlug,
} from "./certification.service.js";

export async function generateCourseCertificateController(req, res) {
  const data = await generateCourseCertificate(req.user.id, req.params.courseSlug);
  return res.status(201).json({ message: "Certificate generated", data });
}

export async function getCertificateBySlugController(req, res) {
  const data = await getCertificateBySlug(req.params.slug);
  return res.json({ message: "Certificate fetched", data });
}
