// No legacy clipboard fallback: a rejection means the user must copy manually.
export async function tryCopy(write, value) {
  try { await write(value); return true; } catch { return false; }
}
