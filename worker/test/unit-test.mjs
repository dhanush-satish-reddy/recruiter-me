// Unit tests for pure helpers. No server needed:  node test/unit-test.mjs
import { stripInventedNumbers } from "../src/guards.js";

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; console.log("  PASS", name); }
  else { fail++; console.log("  FAIL", name, "\n    got: ", got, "\n    want:", want); }
}

console.log("Unit tests");

check(
  "invented numbers become placeholders",
  stripInventedNumbers("Working 15 hours per week with a GPA above 3.5, cutting time by 75 % in 2025.", "I worked at FDI in 2025."),
  "Working [number] hours per week with a GPA above [number], cutting time by [number] % in 2025.",
);
check(
  "numbers the candidate said are kept",
  stripInventedNumbers("I saved 20% time at FDI in 2025.", "I worked at FDI in 2025 and saved 20% time."),
  "I saved 20% time at FDI in 2025.",
);
check(
  "decimal comma and point are treated as equal",
  stripInventedNumbers("My grade was 1.7.", "Meine Note war 1,7."),
  "My grade was 1.7.",
);
check(
  "text without numbers is unchanged",
  stripInventedNumbers("I led the [project name] team.", ""),
  "I led the [project name] team.",
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
