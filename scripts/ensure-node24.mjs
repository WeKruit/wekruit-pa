const expectedMajor = 24
const actual = process.versions.node
const major = Number.parseInt(actual.split(".")[0] ?? "", 10)

if (major !== expectedMajor) {
  console.error(
    [
      `Node ${expectedMajor} is required for this repo; current Node is ${actual}.`,
      `Resolved node: ${process.execPath}`,
      "Run from a shell with nvm using Node 24, or prefix the command with: source ~/.zshrc && nvm use 24",
    ].join("\n"),
  )
  process.exit(1)
}
