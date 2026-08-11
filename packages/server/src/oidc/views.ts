const ESCAPE_MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPE_MAP[char]!);
}

const STYLE = `body{font-family:system-ui,-apple-system,sans-serif;max-width:22rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}
h1{font-size:1.15rem;margin-bottom:1rem}
input{width:100%;padding:.6rem;margin:.4rem 0;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;font-size:1rem}
button{width:100%;padding:.6rem;margin-top:.5rem;border:0;border-radius:4px;background:#1a56db;color:#fff;font-size:1rem;cursor:pointer}
.error{color:#b00020;font-size:.9rem}
.hint{color:#555;font-size:.9rem}`;

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

export function renderLoginForm(opts: { uid: string; clientName?: string; error?: string }): string {
  const heading = opts.clientName ? `Sign in to ${escapeHtml(opts.clientName)}` : "Sign in";
  return page(
    "Sign in",
    `<h1>${heading}</h1>
${opts.error ? `<p class="error">${escapeHtml(opts.error)}</p>` : ""}
<form method="post" action="/interaction/${encodeURIComponent(opts.uid)}/login">
<input name="username" placeholder="Username" autocomplete="username" autofocus required>
<input name="password" type="password" placeholder="Password" autocomplete="current-password" required>
<button type="submit">Continue</button>
</form>`,
  );
}

export function renderMfaForm(opts: { uid: string; username: string; error?: string }): string {
  return page(
    "Verify",
    `<h1>Enter your authenticator code</h1>
<p class="hint">Signed in as <strong>${escapeHtml(opts.username)}</strong></p>
${opts.error ? `<p class="error">${escapeHtml(opts.error)}</p>` : ""}
<form method="post" action="/interaction/${encodeURIComponent(opts.uid)}/mfa">
<input name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="6-digit code" autocomplete="one-time-code" autofocus required>
<button type="submit">Verify</button>
</form>`,
  );
}

export function renderErrorPage(message: string): string {
  return page("Sign-in error", `<h1>Sign-in error</h1><p>${escapeHtml(message)}</p>`);
}
