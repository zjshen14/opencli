export interface Task {
  id: number;
  title: string;
  done: boolean;
}

/** BUG: missing return null in the guard branch */
export function createTask(title: string): Task | null {
  if (!title) {
    console.error("title is required");
  }
  return { id: Date.now(), title, done: false };
}
