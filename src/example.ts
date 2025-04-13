import type { TaskContext } from "./a2a/handler.js";
import * as schema from "./a2a/schema.js";
import { A2AServer } from "./server.js";

async function* mySimpleHandler(
  context: TaskContext,
): AsyncGenerator<
  schema.Artifact | Omit<schema.TaskStatus, "timestamp">,
  schema.Task | void,
  unknown
> {
  console.log(`Handling task ${context.task.id}`);
  yield {
    state: "working",
    message: { role: "agent", parts: [{ text: "Working on it..." }] },
  };

  await new Promise((resolve) => setTimeout(resolve, 1500));

  if (context.isCancelled()) {
    console.log("Task cancelled!");
    // Yielding a final 'canceled' state is good practice
    yield {
      state: "canceled",
      message: {
        role: "agent",
        parts: [{ text: "Cancellation acknowledged." }],
      },
    };
    return; // Stop processing
  }

  yield {
    name: "output.txt", // Artifact needs a name or index
    parts: [{ text: `Result for task ${context.task.id}` }],
  };

  yield {
    state: "completed",
    message: { role: "agent", parts: [{ text: "Done!" }] },
  };
}

// Example: Create and start the server
const server = new A2AServer(mySimpleHandler, {
  card: {
    version: "1.0",
    name: "My Hono Agent",
    url: "http://localhost:41241",
    capabilities: { streaming: true },
    skills: [],
  },
  cors: { origin: "*" }, // Example CORS config
});

// Start the server (using Node.js adapter in this case)
server.start(Number(process.env["PORT"]) || 41241);

console.log(
  `Example Hono A2A server started on port ${Number(process.env["PORT"]) || 41241}`,
);
