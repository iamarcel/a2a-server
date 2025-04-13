# A2A Server Implementation with Hono 🔥

This project provides a modern implementation of the Agent-to-Agent (A2A) Communication Protocol V2 server specification using the [Hono](https://hono.dev/) web framework.

## 🚀 Using This Package

You can easily use this package to build your own A2A-compliant agent server with Hono.

### 1. Installation

Install the package along with Hono and a Hono adapter (like `@hono/node-server` for Node.js):

```bash
pnpm add hono-a2a-server hono @hono/node-server
```

### 2. Creating Your Server

Create a file (e.g., `myAgentServer.ts`) and implement your agent's logic within a `TaskHandler`.

```typescript
// myAgentServer.ts
import { serve } from "@hono/node-server";
import {
  A2AServer,
  type TaskHandler,
  type TaskContext,
  type TaskYieldUpdate,
  schema,
  InMemoryTaskStore,
} from "hono-a2a-server";

// Import the Hono adapter

// 1. Define your Agent's Logic (Task Handler)
// This is where you implement how your agent processes tasks.
async function* myAgentLogic(
  context: TaskContext,
): AsyncGenerator<TaskYieldUpdate, schema.Task | void, unknown> {
  console.log(`[Agent Logic] Handling task: ${context.task.id}`);
  const userPrompt =
    context.userMessage.parts.find((p) => p.text)?.text || "[No prompt found]";
  console.log(`[Agent Logic] User Prompt: ${userPrompt}`);

  // Indicate work is starting
  yield {
    state: "working",
    message: {
      role: "agent",
      parts: [{ text: `Processing request for task ${context.task.id}...` }],
    },
  };

  // Simulate some asynchronous work
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Check for cancellation periodically during long operations
  if (context.isCancelled()) {
    console.log(`[Agent Logic] Task ${context.task.id} was cancelled.`);
    yield {
      state: "canceled",
      message: { role: "agent", parts: [{ text: "Task cancelled by user." }] },
    };
    return; // Stop processing
  }

  // Yield an artifact (e.g., a result file)
  yield {
    name: "result.txt", // Or use index: 0
    mimeType: "text/plain",
    parts: [
      {
        text: `This is the result for task ${context.task.id} based on prompt: "${userPrompt}"`,
      },
    ],
  };

  // Simulate more work
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Yield final status update
  yield {
    state: "completed",
    message: { role: "agent", parts: [{ text: "Task processing complete!" }] },
  };

  // The generator implicitly returns void here, the server handles the final state.
  // You could optionally return the final `schema.Task` object if needed for non-streaming 'tasks/send'.
}

// 2. Configure and Create the Server Instance
const agentCard: schema.AgentCard = {
  version: "1.0.0",
  name: "My Custom Hono Agent",
  description: "An example agent built with hono-a2a-server",
  // Add other optional card properties like endpoints, capabilities etc.
};

const serverOptions: A2AServerOptions = {
  taskStore: new InMemoryTaskStore(),
  card: agentCard,
  cors: {
    // Example: Allow requests from any origin
    origin: "*",
  },
};

const server = new A2AServer(myAgentLogic, serverOptions);

// 3. Start the Server
const port = 41241;
console.log(`Starting custom A2A server on port ${port}...`);

serve(
  {
    fetch: server.createApp().fetch, // Get the Hono app instance and pass its fetch handler
    port: port,
  },
  (info) => {
    console.log(
      `Custom A2A Server (Hono) listening on http://localhost:${info.port}`,
    );
  },
);

// You can now send requests (like the curl examples in the main README section)
// to http://localhost:41241 to interact with your agent.
```

Now you have a running A2A server powered by your custom agent logic and the Hono framework! You can test it using the `curl` commands provided earlier in the README.

## Motivation

The official A2A protocol examples utilize Express.js. While functional, Express is an older framework, and the official samples aren't readily available as installable NPM packages. This project aims to provide:

1.  A **modern alternative** using Hono, known for its speed, lightweight nature, and adherence to Web Standards.
2.  A clear, **TypeScript-first** implementation.
3.  A potentially **packageable** foundation for building A2A-compliant agents.

This implementation leverages the core, framework-agnostic logic (task handling, storage, errors) from the reference structure and rebuilds the server layer using Hono.

## ✨ Features

- **A2A Protocol V2 Compliant:** Implements core methods like `tasks/send`, `tasks/sendSubscribe`, `tasks/get`, `tasks/cancel`.
- **Built with Hono:** Utilizes the ultrafast and lightweight Hono framework.
- **Streaming Support:** Implements `tasks/sendSubscribe` using Server-Sent Events (SSE) via Hono's streaming helpers.
- **Type-Safe:** Written entirely in TypeScript for better maintainability and developer experience.
- **Example Included:** Comes with a runnable example (`index.ts`) demonstrating basic usage.

I imported most of the files from the official A2A JS server example, with just some minor modifications for the strict type checking I've set up here. The Express-based server is reimplemented using Hono (thanks Gemini for the heavy lifting).

## 📦 Installation

Clone the repository and install the dependencies:

## ▶️ Running the Example

The `example.ts` file contains a simple example task handler (`mySimpleHandler`) and starts the A2A server using the Hono implementation.

To run the example server:

```bash
pnpm dev
```

The server will start, typically listening on port `41241`:

```
A2A Server (Hono) listening on port 41241 at path /
Example Hono A2A server started on port 41241
```

## 🧪 Testing the Example Server

You can use `curl` or any other HTTP client to interact with the running example server.

**1. Send a Task (Non-Streaming)**

This sends a task and waits for the final result. Replace `<TASK_ID>` with a unique UUID (you can use `uuidgen` on macOS/Linux or an online generator).

```sh
TASK_ID=$(uuidgen) # Or set your own UUID
curl -X POST http://localhost:41241 \
     -H "Content-Type: application/json" \
     -d '{
       "jsonrpc": "2.0",
       "method": "tasks/send",
       "id": 1,
       "params": {
         "id": "'$TASK_ID'",
         "message": {
           "role": "user",
           "parts": [{"text": "Please do the non-streaming thing."}]
         }
       }
     }'
```

**2. Send a Task and Subscribe (Streaming)**

This sends a task and receives status/artifact updates via Server-Sent Events (SSE). Use `curl -N` to keep the connection open for streaming. Replace `<TASK_ID>` with a unique UUID.

```sh
TASK_ID=$(uuidgen) # Or set your own UUID
curl -N -X POST http://localhost:41241 \
     -H "Content-Type: application/json" \
     -d '{
       "jsonrpc": "2.0",
       "method": "tasks/sendSubscribe",
       "id": 2,
       "params": {
          "id": "'$TASK_ID'",
          "message": {
            "role": "user",
            "parts": [{"text": "Please do the streaming thing."}]
          }
        }
     }'
```

_You should see multiple `data: {...}` lines corresponding to events._

**3. Get Task Status**

Retrieve the current status and details of a previously submitted task. Replace `<EXISTING_TASK_ID>` with an ID from a previous `tasks/send` or `tasks/sendSubscribe` call.

```sh
EXISTING_TASK_ID="<paste-a-task-id-here>" # Replace with a real ID
curl -X POST http://localhost:41241 \
     -H "Content-Type: application/json" \
     -d '{
       "jsonrpc": "2.0",
       "method": "tasks/get",
       "id": 3,
       "params": {
         "id": "'$EXISTING_TASK_ID'"
       }
     }'
```

**4. Cancel a Task**

Attempt to cancel an ongoing task. Replace `<EXISTING_TASK_ID>` with the ID of a task that is likely still in the `working` state.

```sh
EXISTING_TASK_ID="<paste-an-active-task-id-here>" # Replace with a real ID
curl -X POST http://localhost:41241 \
     -H "Content-Type: application/json" \
     -d '{
       "jsonrpc": "2.0",
       "method": "tasks/cancel",
       "id": 4,
       "params": {
         "id": "'$EXISTING_TASK_ID'"
       }
     }'
```

## Contributing

Contributions are welcome! Please feel free to open issues or submit pull requests.
