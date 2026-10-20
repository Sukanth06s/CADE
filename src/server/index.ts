import { createServer } from "node:http";
import { createBackend } from "./app";

const port = Number(
  process.env.PORT ?? process.env.CADE_BACKEND_PORT ?? 4000
);
const backend = createBackend();
const server = createServer(backend.app);
backend.attachWebSocket(server);

server.listen(port, () => {
  console.log(`CADE Rover backend listening on http://localhost:${port}`);
  console.log("WebSocket endpoint: ws://localhost:" + port + "/ws");
});
