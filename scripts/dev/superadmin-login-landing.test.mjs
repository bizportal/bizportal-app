import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../../artifacts/bizportal/src/App.tsx", import.meta.url), "utf8");
const protectedRoute = readFileSync(new URL("../../artifacts/bizportal/src/components/ProtectedRoute.tsx", import.meta.url), "utf8");

test("canonical BizPortal routes super_admin to dashboard", () => {
  assert.match(app, /case "super_admin":\s*case "admin":\s*return "\/dashboard";/);
  assert.match(app, /roleToPath\(dbUser\?\.role \?\? cachedRole \?\? user\?\.role\)/);
});

test("existing division routing and unknown-role fallback stay unchanged", () => {
  for (const [role, path] of [["ecommerce","ecommerce"],["trading","trading"],["logistics","logistics"]]) {
    assert.ok(app.includes(`case "${role}":\n      return "/${path}";`));
  }
  assert.match(app, /default:\s*return "\/welcome";/);
});

test("dashboard remains behind the existing authentication guard", () => {
  assert.match(protectedRoute, /if \(!isAuthenticated\) return <LoginScreen \/>;/);
  assert.match(app, /useGetCurrentUser/);
});
