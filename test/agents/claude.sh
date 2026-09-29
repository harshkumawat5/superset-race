# Fixes the bug and adds a test case.
cat > math.ts <<'TS'
export const add = (a: number, b: number) => a + b;
TS
cat >> math.test.ts <<'TS'
test("adds two numbers", () => expect(add(2, 3)).toBe(5));
TS
