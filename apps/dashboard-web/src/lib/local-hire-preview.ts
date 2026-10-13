/** Restrict the development preview to loopback hosts and the /hire route. */
export function isLocalHirePreview(hostname: string, pathname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname)
    && (pathname === "/hire" || pathname.startsWith("/hire/"))
}
