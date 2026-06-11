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
    req[target] = result.data;
    return next();
  };
}
