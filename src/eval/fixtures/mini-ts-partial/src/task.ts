export interface Task {
  id: number;
  title: string;
  done: boolean;
}

export function createTask(title: string): Task {
  return { id: Date.now(), title, done: false };
}

function validate(task: Task): boolean {
  if (!task.title) return false;
  if (task.id <= 0) return false;
  return true;
}

function formatTitle(title: string): string {
  return title.trim();
}

function assignId(): number {
  return Date.now();
}

function markDone(task: Task): Task {
  return { ...task, done: true };
}

function logTask(task: Task): void {
  console.log(`[Task ${task.id}] ${task.title} done=${task.done}`);
}

function checkTitle(title: string): boolean {
  return title.length > 0 && title.length <= 200;
}

function buildTask(title: string): Task {
  return { id: assignId(), title: formatTitle(title), done: false };
}

// processTask is intentionally long — split into validateTask() + executeTask()
export function processTask(title: string): Task | null {
  if (!title) return null;
  if (title.length > 200) return null;
  if (title.trim() === "") return null;
  const formatted = formatTitle(title);
  if (!checkTitle(formatted)) return null;
  const task = buildTask(formatted);
  if (!validate(task)) return null;
  logTask(task);
  const done = markDone(task);
  logTask(done);
  return done;
}
