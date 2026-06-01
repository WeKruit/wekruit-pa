const root = new URL(".", import.meta.url).pathname
const envDir = new URL("../pa-landing", import.meta.url).pathname

export default {
  root,
  envDir,
}
