# Fixes the bug, adds no test, commits.
cat > math.ts <<'TS'
export const add = (a: number, b: number) => a + b;
TS
git -c user.email=codex@example.com -c user.name=codex commit -qam "fix add"
