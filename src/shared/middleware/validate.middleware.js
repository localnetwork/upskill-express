import { ApiError } from "../utils/ApiError.js";

export function validate(schema, target = "body") {
  return (req, _res, next) => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      return next(
        new ApiError(400, "Validation failed", {
          issues: result.error.issues,
        }),
      );
    }
    if (target === "query" && req.query && typeof req.query === "object") {
      for (const key of Object.keys(req.query)) {
        delete req.query[key];
      }
      Object.assign(req.query, result.data);
    } else {
      req[target] = result.data;
    }
    return next();
  };
}
