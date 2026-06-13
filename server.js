import app from "./app.js";
import { env } from "./src/shared/config/env.js";
import { createServer } from "http";
import { initSocket } from "./src/shared/realtime/socket.js";

const PORT = env.port;
const server = createServer(app);
initSocket(server);

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
