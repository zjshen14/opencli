import type { Task } from "./task.js";

export function createTask(title: string): Task {
  return { id: Date.now(), title, done: false };
}
