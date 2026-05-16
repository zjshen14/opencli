export interface Task {
  id: number;
  title: string;
  done: boolean;
}

export function createTask(title: string): Task {
  return { id: Date.now(), title, done: false };
}
