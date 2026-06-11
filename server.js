import app from "./app.js";
import { env } from "./src/shared/config/env.js";

const PORT = env.port;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
