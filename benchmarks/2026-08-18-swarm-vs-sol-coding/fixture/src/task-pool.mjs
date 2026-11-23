export class TaskPoolClosedError extends Error {
  constructor(message = "Task pool is closed") {
    super(message);
    this.name = "TaskPoolClosedError";
  }
}

export class TaskPoolTimeoutError extends Error {
  constructor(taskId) {
    super(`Task timed out: ${taskId}`);
    this.name = "TaskPoolTimeoutError";
    this.taskId = taskId;
  }
}

export class AsyncTaskPool {
  constructor(_options) {
    throw new Error("TODO: implement AsyncTaskPool");
  }
}

