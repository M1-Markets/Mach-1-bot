/** @type {import('mocha').MochaOptions} */
module.exports = {
  spec: "tests/**/*.test.ts",
  import: ["tsx"],
  timeout: 20000,
  exit: true,
};
