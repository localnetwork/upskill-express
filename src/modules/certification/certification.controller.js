import {
  generateCourseCertificate,
  getCertificateBySlug,
  listMyCertificates,
  setCertificateProfileVisibility,
} from "./certification.service.js";

export async function listMyCertificatesController(req, res) {
  const data = await listMyCertificates(req.user.id);
  return res.json({ message: "Certificates fetched", data });
}

export async function setCertificateVisibilityController(req, res) {
  if (typeof req.body?.show_on_profile !== "boolean") {
    return res.status(400).json({ message: "show_on_profile must be a boolean" });
  }
  const data = await setCertificateProfileVisibility(
    req.user.id,
    req.params.slug,
    req.body.show_on_profile,
  );
  return res.json({ message: "Certificate visibility updated", data });
}

export async function generateCourseCertificateController(req, res) {
  const data = await generateCourseCertificate(req.user.id, req.params.courseSlug);
  return res.status(201).json({ message: "Certificate generated", data });
}

export async function getCertificateBySlugController(req, res) {
  const data = await getCertificateBySlug(req.params.slug);
  return res.json({ message: "Certificate fetched", data });
}
