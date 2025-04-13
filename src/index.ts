export { A2AServer } from "./server.js";
export type { A2AServerOptions } from "./server.js";

export type {
  TaskHandler,
  TaskYieldUpdate,
  TaskContext,
} from "./a2a/handler.js"; // Ensure .js extension

export type { TaskStore, TaskAndHistory } from "./a2a/store.js"; // Ensure .js extension
export { InMemoryTaskStore, FileStore } from "./a2a/store.js"; // Ensure .js extension

export * as schema from "./a2a/schema.js";
