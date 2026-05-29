import type { CSSProperties, ReactNode } from "react"
import { Link } from "react-router-dom"

export function jobWorkspacePath(jobId: string): string {
  return `/admin/jobs/${encodeURIComponent(jobId)}`
}

export function candidateProfilePath(userId: string, fragment?: string): string {
  const hash = fragment ? `#${encodeURIComponent(fragment)}` : ""
  return `/admin/candidates/${encodeURIComponent(userId)}/profile${hash}`
}

export function prescreenSessionPath(sessionId: string): string {
  return `/admin/prescreen-sessions/${encodeURIComponent(sessionId)}`
}

export function AdminJobLink({
  jobId,
  children,
  style,
}: {
  jobId: string
  children?: ReactNode
  style?: CSSProperties
}) {
  return <AdminEntityLink to={jobWorkspacePath(jobId)} title={`Open job ${jobId}`} style={style}>{children ?? jobId}</AdminEntityLink>
}

export function AdminUserLink({
  userId,
  children,
  style,
  fragment,
}: {
  userId: string
  children?: ReactNode
  style?: CSSProperties
  fragment?: string
}) {
  return <AdminEntityLink to={candidateProfilePath(userId, fragment)} title={`Open candidate ${userId}`} style={style}>{children ?? userId}</AdminEntityLink>
}

export function AdminPrescreenSessionLink({
  sessionId,
  children,
  style,
}: {
  sessionId: string
  children?: ReactNode
  style?: CSSProperties
}) {
  return <AdminEntityLink to={prescreenSessionPath(sessionId)} title={`Open prescreen session ${sessionId}`} style={style}>{children ?? sessionId}</AdminEntityLink>
}

function AdminEntityLink({
  to,
  title,
  children,
  style,
}: {
  to: string
  title: string
  children: ReactNode
  style?: CSSProperties
}) {
  return (
    <Link
      to={to}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      onClick={(event) => event.stopPropagation()}
      style={{ color: "#2563eb", overflowWrap: "anywhere", ...style }}
    >
      {children}
    </Link>
  )
}
