import { A2AError } from "./a2a/error.js";
import { type TaskHandler, type TaskContext } from "./a2a/handler.js";
import * as schema from "./a2a/schema.js";
import {
  type TaskStore,
  InMemoryTaskStore,
  type TaskAndHistory,
} from "./a2a/store.js";
import {
  getCurrentTimestamp,
  isTaskStatusUpdate,
  isArtifactUpdate,
} from "./a2a/utils.js";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";

/**
 * Options for configuring the A2AServer.
 */
export interface A2AServerOptions {
  /** Task storage implementation. Defaults to InMemoryTaskStore. */
  taskStore?: TaskStore;
  /** CORS configuration options. Defaults to allowing all origins. */
  cors?: Parameters<typeof cors>[0];
  /** Base path for the A2A endpoint. Defaults to '/'. */
  basePath?: string;
  /** Agent Card for the agent being served. */
  card?: schema.AgentCard;
}

/**
 * Implements an A2A specification compliant server using Hono.
 */
export class A2AServer {
  private taskHandler: TaskHandler;
  private taskStore: TaskStore;
  private corsOptions: Parameters<typeof cors>[0];
  private basePath: string;
  private activeCancellations: Set<string> = new Set();
  card: schema.AgentCard | undefined; // Made optional to allow instantiation without it initially

  constructor(handler: TaskHandler, options: A2AServerOptions = {}) {
    this.taskHandler = handler;
    this.taskStore = options.taskStore ?? new InMemoryTaskStore();
    this.corsOptions = options.cors;
    this.basePath = options.basePath ?? "/";
    this.card = options.card;

    // Ensure base path starts with a slash and does not end with one unless it's just "/"
    if (this.basePath !== "/") {
      this.basePath = `/${this.basePath.replace(/^\/|\/$/g, "")}`;
    }
    // Ensure base path ends with a slash if it's not just "/" to allow easy concatenation
    if (this.basePath !== "/" && !this.basePath.endsWith("/")) {
      this.basePath += "/";
    }
  }

  /**
   * Creates and configures the Hono application instance.
   * @returns The configured Hono instance.
   */
  createApp(): Hono {
    const app = new Hono();

    // Configure CORS middleware for the entire application or specific base path
    app.use("*", cors(this.corsOptions));

    // Agent Card endpoint
    if (this.card) {
      app.get("/.well-known/agent.json", (c) => c.json(this.card));
    }

    // Mount the main A2A endpoint handler
    // Hono handles trailing slashes automatically by default (strict: false)
    // Ensure basePath ends without a slash for route definition if not root
    const routePath = this.basePath === "/" ? "/" : this.basePath.slice(0, -1);
    app.post(routePath, this.endpoint());

    // Configure Hono's built-in error handler
    app.onError(this.errorHandler);

    return app;
  }

  /**
   * Starts the Hono server using the specified adapter (e.g., Node.js server).
   * @param port Port number to listen on. Defaults to 41241.
   * @returns The running server instance from the adapter.
   */
  start(port = 41241): ServerType {
    const app = this.createApp();
    console.log(
      `A2A Server (Hono) listening on port ${port} at path ${this.basePath}`,
    );
    return serve({ fetch: app.fetch, port });
  }

  /**
   * Returns a Hono Handler function to handle A2A requests.
   */
  private endpoint(): (c: Context) => Promise<Response> {
    return async (c: Context) => {
      let requestBody: schema.JSONRPCRequest | unknown;
      let taskId: string | undefined; // For error context

      try {
        // 1. Parse and validate JSON body
        try {
          requestBody = await c.req.json();
        } catch (parseErr) {
          throw A2AError.parseError(
            parseErr instanceof Error ? parseErr.message : String(parseErr),
          );
        }

        // 2. Validate basic JSON-RPC structure
        if (!this.isValidJsonRpcRequest(requestBody)) {
          throw A2AError.invalidRequest("Invalid JSON-RPC request structure.");
        }

        // Attempt to get task ID early for error context
        taskId = (requestBody as schema.SendTaskRequest).params?.id;

        // 3. Route based on method
        switch (requestBody.method) {
          case "tasks/send":
            return await this.handleTaskSend(
              requestBody as schema.SendTaskRequest,
              c,
            );
          case "tasks/sendSubscribe":
            // streamSSE handles the response directly
            return this.handleTaskSendSubscribe(
              requestBody as schema.SendTaskStreamingRequest,
              c,
            );
          case "tasks/get":
            return await this.handleTaskGet(
              requestBody as schema.GetTaskRequest,
              c,
            );
          case "tasks/cancel":
            return await this.handleTaskCancel(
              requestBody as schema.CancelTaskRequest,
              c,
            );
          // Add other methods like tasks/pushNotification/*, tasks/resubscribe later if needed
          default:
            throw A2AError.methodNotFound(requestBody.method);
        }
      } catch (error) {
        // Errors caught here will be passed to the Hono onError handler
        if (error instanceof A2AError && taskId && !error.taskId) {
          error.taskId = taskId; // Add task ID context if missing
        }
        // Re-throw for Hono's onError to handle
        throw error;
      }
    };
  }

  // --- Request Handlers ---

  private async handleTaskSend(
    req: schema.SendTaskRequest,
    c: Context,
  ): Promise<Response> {
    this.validateTaskSendParams(req.params);
    const { id: taskId, message, sessionId, metadata } = req.params;

    let currentData = await this.loadOrCreateTaskAndHistory(
      taskId,
      message,
      sessionId,
      metadata,
    );
    const context = this.createTaskContext(
      currentData.task,
      message,
      currentData.history,
    );
    const generator = this.taskHandler(context);

    try {
      for await (const yieldValue of generator) {
        currentData = this.applyUpdateToTaskAndHistory(currentData, yieldValue);
        await this.taskStore.save(currentData);
        context.task = currentData.task; // Update context snapshot
      }
    } catch (handlerError) {
      currentData = this.applyUpdateToTaskAndHistory(currentData, {
        state: "failed",
        message: {
          role: "agent",
          parts: [
            {
              text: `Handler failed: ${
                handlerError instanceof Error
                  ? handlerError.message
                  : String(handlerError)
              }`,
            },
          ],
        },
      });
      try {
        await this.taskStore.save(currentData);
      } catch (saveError) {
        console.error(
          `Failed to save task ${taskId} after handler error:`,
          saveError,
        );
      }
      // Rethrow the original error for the onError handler
      throw this.normalizeErrorForThrow(handlerError, req.id, taskId);
    }

    // Send the final task state as JSON-RPC success response
    return this.sendJsonResponse(c, req.id, currentData.task);
  }

  // handleTaskSendSubscribe now returns a Response generated by streamSSE
  private handleTaskSendSubscribe(
    req: schema.SendTaskStreamingRequest,
    c: Context,
  ): Response {
    // Perform initial validations *before* starting the stream
    try {
      this.validateTaskSendParams(req.params);
    } catch (validationError) {
      // If validation fails, immediately return a standard JSON-RPC error response
      const normalizedError = this.normalizeError(
        validationError,
        req.id,
        req.params.id, // Try to get taskId for error context
      );
      return c.json(normalizedError, 200); // JSON-RPC uses 200 OK for errors
    }

    const { id: taskId, message, sessionId, metadata } = req.params;

    return streamSSE(c, async (stream) => {
      let currentData: TaskAndHistory | null = null;
      let context: TaskContext | null = null;
      let lastEventWasFinal = false;

      try {
        // Load or create task AND history inside the stream initialization
        currentData = await this.loadOrCreateTaskAndHistory(
          taskId,
          message,
          sessionId,
          metadata,
        );
        context = this.createTaskContext(
          currentData.task,
          message,
          currentData.history,
        );
        const generator = this.taskHandler(context);

        // Process generator yields
        for await (const yieldValue of generator) {
          if (!currentData || !context) break; // Should not happen if initialized

          currentData = this.applyUpdateToTaskAndHistory(
            currentData,
            yieldValue,
          );
          await this.taskStore.save(currentData);
          context.task = currentData.task; // Update context snapshot

          let event:
            | schema.TaskStatusUpdateEvent
            | schema.TaskArtifactUpdateEvent;
          let isFinal = false;

          if (isTaskStatusUpdate(yieldValue)) {
            const terminalStates: schema.TaskState[] = [
              "completed",
              "failed",
              "canceled",
              "input-required",
            ];
            isFinal = terminalStates.includes(currentData.task.status.state);
            event = this.createTaskStatusEvent(
              taskId,
              currentData.task.status,
              isFinal,
            );
          } else if (isArtifactUpdate(yieldValue)) {
            const updatedArtifact =
              currentData.task.artifacts?.find(
                (a: schema.Artifact) =>
                  (a.index !== undefined && a.index === yieldValue.index) ||
                  (a.name && a.name === yieldValue.name),
              ) ?? yieldValue;
            event = this.createTaskArtifactEvent(
              taskId,
              updatedArtifact,
              false,
            );
          } else {
            console.warn("[SSE] Handler yielded unknown value:", yieldValue);
            continue;
          }

          await stream.writeSSE({
            data: JSON.stringify(this.createSuccessResponse(req.id, event)),
            // Hono's streamSSE expects data as string, id as string, event as string
            // We embed the JSON-RPC structure within the 'data' field.
          });
          lastEventWasFinal = isFinal;

          if (isFinal) break;
        } // End for-await loop

        // --- Loop finished ---
        if (!currentData) throw new Error("Task data lost during stream");

        if (!lastEventWasFinal) {
          const finalStates: schema.TaskState[] = [
            "completed",
            "failed",
            "canceled",
            "input-required",
          ];
          if (!finalStates.includes(currentData.task.status.state)) {
            console.warn(
              `[SSE ${taskId}] Task ended non-terminally (${currentData.task.status.state}). Forcing 'completed'.`,
            );
            currentData = this.applyUpdateToTaskAndHistory(currentData, {
              state: "completed",
            });
            await this.taskStore.save(currentData);
          }

          const finalEvent = this.createTaskStatusEvent(
            taskId,
            currentData.task.status,
            true, // Mark as final
          );
          await stream.writeSSE({
            data: JSON.stringify(
              this.createSuccessResponse(req.id, finalEvent),
            ),
          });
        }
      } catch (handlerError) {
        console.error(`[SSE ${taskId}] Error during streaming:`, handlerError);

        // If an error occurs *during* streaming, try to update state and send a final error event.
        if (currentData) {
          const failureUpdate: Omit<schema.TaskStatus, "timestamp"> = {
            state: "failed",
            message: {
              role: "agent",
              parts: [
                {
                  text: `Handler failed: ${handlerError instanceof Error ? handlerError.message : String(handlerError)}`,
                },
              ],
            },
          };
          currentData = this.applyUpdateToTaskAndHistory(
            currentData,
            failureUpdate,
          );
          try {
            await this.taskStore.save(currentData);
          } catch (saveError) {
            console.error(
              `[SSE ${taskId}] Failed to save task after handler error:`,
              saveError,
            );
          }

          // Send final error status event via SSE
          const errorEvent = this.createTaskStatusEvent(
            taskId,
            currentData.task.status, // Use the updated status
            true, // Mark as final
          );
          try {
            await stream.writeSSE({
              data: JSON.stringify(
                this.createSuccessResponse(req.id, errorEvent),
              ),
            });
          } catch (sseWriteError) {
            console.error(
              `[SSE ${taskId}] Failed to write final error event to stream:`,
              sseWriteError,
            );
          }
        } else {
          // Error happened before task data was loaded/created
          console.error(
            `[SSE ${taskId}] Error occurred before task initialization.`,
          );
          // Cannot send SSE event, the stream might not even be properly open.
          // The client will likely just time out or disconnect.
        }

        // No need to re-throw here as streamSSE handles stream closure.
        // We've signaled the error via the SSE stream itself.
      } finally {
        // streamSSE handles closing the stream automatically on completion or error.
        console.log(`[SSE ${taskId}] Stream finished.`);
      }
    }); // End streamSSE
  }

  private async handleTaskGet(
    req: schema.GetTaskRequest,
    c: Context,
  ): Promise<Response> {
    const { id: taskId } = req.params;
    if (!taskId) throw A2AError.invalidParams("Missing task ID.");

    const data = await this.taskStore.load(taskId);
    if (!data) {
      throw A2AError.taskNotFound(taskId);
    }
    return this.sendJsonResponse(c, req.id, data.task);
  }

  private async handleTaskCancel(
    req: schema.CancelTaskRequest,
    c: Context,
  ): Promise<Response> {
    const { id: taskId } = req.params;
    if (!taskId) throw A2AError.invalidParams("Missing task ID.");

    let data = await this.taskStore.load(taskId);
    if (!data) {
      throw A2AError.taskNotFound(taskId);
    }

    const finalStates: schema.TaskState[] = ["completed", "failed", "canceled"];
    if (finalStates.includes(data.task.status.state)) {
      console.log(
        `Task ${taskId} already in final state ${data.task.status.state}, cannot cancel.`,
      );
      return this.sendJsonResponse(c, req.id, data.task); // Return current state
    }

    this.activeCancellations.add(taskId);

    const cancelUpdate: Omit<schema.TaskStatus, "timestamp"> = {
      state: "canceled",
      message: {
        role: "agent",
        parts: [{ text: "Task cancelled by request." }],
      },
    };
    data = this.applyUpdateToTaskAndHistory(data, cancelUpdate);

    await this.taskStore.save(data);
    this.activeCancellations.delete(taskId);

    return this.sendJsonResponse(c, req.id, data.task);
  }

  // --- Helper Methods ---
  // (These methods are mostly reused from the Express version, slightly adapted if needed)

  private applyUpdateToTaskAndHistory(
    current: TaskAndHistory,
    update: Omit<schema.TaskStatus, "timestamp"> | schema.Artifact,
  ): TaskAndHistory {
    // This function seems robust and framework-agnostic. Keep as is.
    const newTask: schema.Task = { ...current.task };
    const newHistory: schema.Message[] = [...current.history];

    if (isTaskStatusUpdate(update)) {
      newTask.status = {
        ...newTask.status,
        ...update,
        timestamp: getCurrentTimestamp(),
      };
      if (update.message?.role === "agent") {
        newHistory.push(update.message);
      }
    } else if (isArtifactUpdate(update)) {
      if (!newTask.artifacts) {
        newTask.artifacts = [];
      } else {
        newTask.artifacts = [...newTask.artifacts];
      }

      const existingIndex = update.index ?? -1;
      let replaced = false;

      if (existingIndex >= 0 && existingIndex < newTask.artifacts.length) {
        const existingArtifact = newTask.artifacts[existingIndex];
        if (update.append) {
          const appendedArtifact = JSON.parse(JSON.stringify(existingArtifact));
          appendedArtifact.parts.push(...update.parts);
          if (update.metadata) {
            appendedArtifact.metadata = {
              ...(appendedArtifact.metadata || {}),
              ...update.metadata,
            };
          }
          if (update.lastChunk !== undefined)
            appendedArtifact.lastChunk = update.lastChunk;
          if (update.description)
            appendedArtifact.description = update.description;
          newTask.artifacts[existingIndex] = appendedArtifact;
          replaced = true;
        } else {
          newTask.artifacts[existingIndex] = { ...update };
          replaced = true;
        }
      } else if (update.name) {
        const namedIndex = newTask.artifacts.findIndex(
          (a) => a.name === update.name,
        );
        if (namedIndex >= 0) {
          newTask.artifacts[namedIndex] = { ...update };
          replaced = true;
        }
      }

      if (!replaced) {
        newTask.artifacts.push({ ...update });
        if (newTask.artifacts.some((a) => a.index !== undefined)) {
          newTask.artifacts.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        }
      }
    }
    return { task: newTask, history: newHistory };
  }

  private async loadOrCreateTaskAndHistory(
    taskId: string,
    initialMessage: schema.Message,
    sessionId?: string | null,
    metadata?: Record<string, unknown> | null,
  ): Promise<TaskAndHistory> {
    // This function seems robust and framework-agnostic. Keep as is.
    let data = await this.taskStore.load(taskId);
    let needsSave = false;

    if (!data) {
      const initialTask: schema.Task = {
        id: taskId,
        sessionId: sessionId ?? undefined,
        status: {
          state: "submitted",
          timestamp: getCurrentTimestamp(),
          message: null,
        },
        artifacts: [],
        metadata: metadata ?? undefined,
      };
      const initialHistory: schema.Message[] = [initialMessage];
      data = { task: initialTask, history: initialHistory };
      needsSave = true;
      console.log(`[Task ${taskId}] Created new task and history.`);
    } else {
      console.log(`[Task ${taskId}] Loaded existing task and history.`);
      data = { task: data.task, history: [...data.history, initialMessage] };
      needsSave = true;

      const finalStates: schema.TaskState[] = [
        "completed",
        "failed",
        "canceled",
      ];
      if (finalStates.includes(data.task.status.state)) {
        console.warn(
          `[Task ${taskId}] Received message for task already in final state ${data.task.status.state}. Handling as new submission (keeping history).`,
        );
        const resetUpdate: Omit<schema.TaskStatus, "timestamp"> = {
          state: "submitted",
          message: null,
        };
        data = this.applyUpdateToTaskAndHistory(data, resetUpdate);
      } else if (data.task.status.state === "input-required") {
        console.log(
          `[Task ${taskId}] Received message while 'input-required', changing state to 'working'.`,
        );
        const workingUpdate: Omit<schema.TaskStatus, "timestamp"> = {
          state: "working",
        };
        data = this.applyUpdateToTaskAndHistory(data, workingUpdate);
      } else if (data.task.status.state === "working") {
        console.warn(
          `[Task ${taskId}] Received message while already 'working'. Proceeding.`,
        );
      }
    }

    if (needsSave) {
      await this.taskStore.save(data);
    }

    return { task: { ...data.task }, history: [...data.history] };
  }

  private createTaskContext(
    task: schema.Task,
    userMessage: schema.Message,
    history: schema.Message[],
  ): TaskContext {
    // This function is correct and framework-agnostic. Keep as is.
    return {
      task: { ...task },
      userMessage: userMessage,
      history: [...history],
      isCancelled: () => this.activeCancellations.has(task.id),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private isValidJsonRpcRequest(body: any): body is schema.JSONRPCRequest {
    // This function is correct and framework-agnostic. Keep as is.
    return (
      typeof body === "object" &&
      body !== null &&
      body.jsonrpc === "2.0" &&
      typeof body.method === "string" &&
      (body.id === null ||
        typeof body.id === "string" ||
        typeof body.id === "number") &&
      (body.params === undefined ||
        typeof body.params === "object" ||
        Array.isArray(body.params))
    );
  }

  private validateTaskSendParams(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params: any,
  ): asserts params is schema.TaskSendParams {
    // This function is correct and framework-agnostic. Keep as is.
    if (!params || typeof params !== "object") {
      throw A2AError.invalidParams("Missing or invalid params object.");
    }
    if (typeof params.id !== "string" || params.id === "") {
      throw A2AError.invalidParams("Invalid or missing task ID (params.id).");
    }
    if (
      !params.message ||
      typeof params.message !== "object" ||
      !Array.isArray(params.message.parts)
    ) {
      throw A2AError.invalidParams(
        "Invalid or missing message object (params.message).",
      );
    }
  }

  // --- Response Formatting ---

  private createSuccessResponse<T>(
    id: number | string | null | undefined,
    result: T,
  ): schema.JSONRPCResponse<T> {
    if (id == null) {
      throw A2AError.internalError(
        "Cannot create success response for null ID.",
      );
    }
    return {
      jsonrpc: "2.0",
      id: id,
      result: result,
    };
  }

  private createErrorResponse(
    id: number | string | null | undefined,
    error: schema.JSONRPCError<unknown>,
  ): schema.JSONRPCResponse<null, unknown> {
    return {
      jsonrpc: "2.0",
      id: id, // Can be null if request ID was invalid/missing
      error: error,
    };
  }

  /** Normalizes various error types into a JSONRPCResponse containing an error */
  private normalizeError(
    error: unknown,
    reqId: number | string | null | undefined,
    taskId?: string,
  ): schema.JSONRPCResponse<null, unknown> {
    // This function is mostly correct. Ensure taskId is properly added.
    let a2aError: A2AError;
    if (error instanceof A2AError) {
      a2aError = error;
    } else if (error instanceof Error) {
      a2aError = A2AError.internalError(error.message, { stack: error.stack });
    } else {
      a2aError = A2AError.internalError("An unknown error occurred.", error);
    }

    if (taskId && !a2aError.taskId) {
      a2aError.taskId = taskId;
    }

    console.error(
      `Error processing request (Task: ${a2aError.taskId ?? "N/A"}, ReqID: ${
        reqId ?? "N/A"
      }):`,
      a2aError.message,
      a2aError.code,
      a2aError.data,
      a2aError.stack, // Log more details
    );

    return this.createErrorResponse(reqId, a2aError.toJSONRPCError());
  }

  /** Normalizes error specifically for re-throwing within async handlers */
  private normalizeErrorForThrow(
    error: unknown,
    reqId: number | string | null | undefined,
    taskId?: string,
  ): A2AError {
    let a2aError: A2AError;
    if (error instanceof A2AError) {
      a2aError = error;
    } else if (error instanceof Error) {
      a2aError = A2AError.internalError(error.message, { stack: error.stack });
    } else {
      a2aError = A2AError.internalError("An unknown error occurred.", error);
    }
    // Ensure Task ID context is present if possible
    if (taskId && !a2aError.taskId) {
      a2aError.taskId = taskId;
    }
    // Add request ID to data if not already present and error is internal
    if (a2aError.code === schema.ErrorCodeInternalError && reqId !== null) {
      if (!a2aError.data || typeof a2aError.data !== "object") {
        a2aError.data = { requestId: reqId };
      } else if (
        typeof a2aError.data === "object" &&
        !("requestId" in a2aError.data)
      ) {
        (a2aError.data as Record<string, unknown>)["requestId"] = reqId;
      }
    }
    return a2aError;
  }

  /** Creates a TaskStatusUpdateEvent object */
  private createTaskStatusEvent(
    taskId: string,
    status: schema.TaskStatus,
    final: boolean,
  ): schema.TaskStatusUpdateEvent {
    // This function is correct and framework-agnostic. Keep as is.
    return {
      id: taskId,
      status: status,
      final: final,
    };
  }

  /** Creates a TaskArtifactUpdateEvent object */
  private createTaskArtifactEvent(
    taskId: string,
    artifact: schema.Artifact,
    final: boolean,
  ): schema.TaskArtifactUpdateEvent {
    // This function is correct and framework-agnostic. Keep as is.
    return {
      id: taskId,
      artifact: artifact,
      final: final,
    };
  }

  /** Hono error handling middleware */
  private errorHandler = (err: Error, c: Context): Response => {
    // Hono's onError receives the actual Error object
    console.error(`[Hono ErrorHandler] Caught error:`, err);

    let reqId: string | number | null = null;
    let taskId: string | undefined = undefined;

    // Attempt to extract request ID and task ID from the context or error
    try {
      // If the request handler ran, it might have parsed the body
      // We need a safe way to access it if available.
      // Hono doesn't store the parsed body on context directly after error.
      // If the error happened *during* JSON parsing, c.req.json() would fail again.
      // Best effort: check if the error object itself carries info.
      if (err instanceof A2AError) {
        taskId = err.taskId;
        // Attempt to get reqId from A2AError data if added by normalizeErrorForThrow
        if (
          typeof err.data === "object" &&
          err.data !== null &&
          "requestId" in err.data
        ) {
          reqId = err.data.requestId as string | number | null;
        }
      }

      // If reqId is still null, maybe it's on the original request body if accessible?
      // This is unreliable after the fact in Hono's error handler.
      // Consider logging c.req for debugging if needed, but avoid parsing again.
    } catch (e) {
      console.error("Error trying to extract info during error handling:", e);
    }

    const normalizedErrorResponse = this.normalizeError(err, reqId, taskId);

    // JSON-RPC errors should be returned with HTTP 200 OK
    return c.json(normalizedErrorResponse, 200);
  };

  /** Sends a standard JSON-RPC success response */
  private sendJsonResponse<T>(
    c: Context,
    reqId: number | string | null | undefined,
    result: T,
  ): Response {
    if (reqId == null) {
      console.warn(
        "Attempted to send JSON response for a request with null ID.",
      );
      // Return a JSON-RPC error response indicating an issue
      const errorResp = this.createErrorResponse(null, {
        code: schema.ErrorCodeInternalError,
        message: "Cannot create success response for request with null ID.",
      });
      return c.json(errorResp, 200);
    }
    return c.json(this.createSuccessResponse(reqId, result));
  }
}
