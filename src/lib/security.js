// Compares the admin secret in a way that takes the same time however many
// characters are correct, so it can't be guessed by timing.
export function isAdminRequest(request, env) {
  const given = request.headers.get("x-admin-secret") || "";
  const secret = env.ADMIN_SECRET || "";
  if (!secret) return false;
  let diff = given.length ^ secret.length;
  for (let i = 0; i < Math.min(given.length, secret.length); i++) diff |= given.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}
