const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const BACKSPACE = String.fromCharCode(127);

// --- Non-TTY (piped) input: buffer raw chunks into a line queue. ---
// A single persistent listener is used so lines arriving before anyone is
// waiting for them are queued, and callers awaiting a line block until one
// arrives - this avoids races where multiple short-lived readline
// interfaces attached to the same already-buffered stdin stream silently
// drop lines.
let pipeListenerAttached = false;
let pipeBuffer = "";
const lineQueue: string[] = [];
const waiters: Array<(line: string) => void> = [];

function ensurePipeListener(): void {
  if (pipeListenerAttached) {
    return;
  }
  pipeListenerAttached = true;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    pipeBuffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = pipeBuffer.indexOf("\n")) !== -1) {
      const line = pipeBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      pipeBuffer = pipeBuffer.slice(newlineIndex + 1);
      const waiter = waiters.shift();
      if (waiter) {
        waiter(line);
      } else {
        lineQueue.push(line);
      }
    }
  });
  process.stdin.resume();
}

function readLineFromPipe(): Promise<string> {
  ensurePipeListener();
  const queued = lineQueue.shift();
  if (queued !== undefined) {
    return Promise.resolve(queued);
  }
  return new Promise((resolve) => waiters.push(resolve));
}

// --- TTY input: read raw keystrokes so we can mask password characters. ---
function readLineFromTty(mask: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let input = "";
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\n" || char === "\r" || char === CTRL_D) {
          cleanup();
          process.stdout.write("\n");
          resolve(input);
          return;
        }
        if (char === CTRL_C) {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Prompt cancelled"));
          return;
        }
        if (char === BACKSPACE || char === "\b") {
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        input += char;
        process.stdout.write(mask ? "*" : char);
      }
    };

    stdin.on("data", onData);
  });
}

/** Prompts for a single line of plain (visible) input. */
export async function promptText(question: string): Promise<string> {
  process.stdout.write(question);
  const line = process.stdin.isTTY ? await readLineFromTty(false) : await readLineFromPipe();
  return line.trim();
}

/**
 * Prompts for input without echoing it to the terminal (masked with `*`),
 * used for master passwords. Falls back to plain buffered input when stdin
 * isn't a TTY (e.g. piped input in scripts/tests), since there's no terminal
 * echo to suppress in that case.
 */
export async function promptHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const line = process.stdin.isTTY ? await readLineFromTty(true) : await readLineFromPipe();
  return line;
}

/** Releases stdin so the process can exit once prompting is done. */
export function closePrompts(): void {
  process.stdin.pause();
}
